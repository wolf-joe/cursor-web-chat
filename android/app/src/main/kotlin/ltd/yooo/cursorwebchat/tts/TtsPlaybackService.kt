package ltd.yooo.cursorwebchat.tts

import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioTrack
import android.media.MediaPlayer
import android.media.session.MediaSession
import android.media.session.PlaybackState
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.util.Base64
import android.util.Log
import androidx.core.content.ContextCompat
import ltd.yooo.cursorwebchat.AppSettings
import ltd.yooo.cursorwebchat.MainActivityBridge
import ltd.yooo.cursorwebchat.ShellBusy
import ltd.yooo.cursorwebchat.net.HttpClient
import ltd.yooo.cursorwebchat.net.SseReader
import okhttp3.Call
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.util.concurrent.Executors

/**
 * 决策·native-owns-media / 决策·fgs-split: 壳内 TTS 在 mediaPlayback 前台服务里
 * 拉 PCM SSE 或 wav,锁屏可听完;网页只遥控。划掉通知 = 停止朗读,不等于 cancel run。
 */
class TtsPlaybackService : Service() {
    private val worker = Executors.newSingleThreadExecutor()
    private val main = Handler(Looper.getMainLooper())
    private var mediaSession: MediaSession? = null
    private var track: AudioTrack? = null
    private var wavPlayer: MediaPlayer? = null
    private var streamCall: Call? = null
    private var focusRequest: AudioFocusRequest? = null
    private var generation = 0
    private var runId: String = ""
    private var mode = MODE_IDLE
    private var phase = ""
    private var paused = false
    private var error: String? = null
    private var sampleRate = 24_000
    private var writtenBytes = 0L
    private var streamDone = false

    private val progressTick = object : Runnable {
        override fun run() {
            if (mode == MODE_CACHED && wavPlayer != null) {
                emit()
                refreshNotification()
                if (!paused) main.postDelayed(this, 400)
            }
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        TtsNotifications.ensureChannel(this)
        val session = MediaSession(this, "CwcTts").also { mediaSession = it }
        session.setCallback(
            object : MediaSession.Callback() {
                override fun onPlay() { applyResume() }
                override fun onPause() { applyPause() }
                override fun onStop() { applyStop() }
                override fun onSeekTo(pos: Long) { applySeek(pos / 1000.0) }
            },
        )
        session.isActive = true
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        promoteForeground()
        when (intent?.action) {
            ACTION_PLAY -> {
                val id = intent.getStringExtra(EXTRA_RUN_ID).orEmpty()
                val cwd = intent.getStringExtra(EXTRA_CWD).orEmpty()
                val agentId = intent.getStringExtra(EXTRA_AGENT_ID).orEmpty()
                if (id.isNotEmpty() && cwd.isNotEmpty() && agentId.isNotEmpty()) {
                    startPlay(id, cwd, agentId)
                }
            }
            TtsNotifications.ACTION_PAUSE, ACTION_PAUSE -> applyPause()
            TtsNotifications.ACTION_RESUME, ACTION_RESUME -> applyResume()
            TtsNotifications.ACTION_STOP, ACTION_STOP -> applyStop()
            ACTION_SEEK -> applySeek(intent.getDoubleExtra(EXTRA_SEEK, 0.0))
        }
        if (mode == MODE_IDLE && intent?.action != ACTION_PLAY) {
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf()
        }
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        generation += 1
        releaseOutputs()
        abandonFocus()
        mediaSession?.isActive = false
        mediaSession?.release()
        mediaSession = null
        worker.shutdownNow()
        ShellBusy.setTtsPlaying(false)
        super.onDestroy()
    }

    private fun promoteForeground() {
        val session = mediaSession ?: return
        val n = TtsNotifications.ongoing(this, session, paused, mode == MODE_LOADING)
        if (Build.VERSION.SDK_INT >= 34) {
            startForeground(
                TtsNotifications.ID_ONGOING,
                n,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK,
            )
        } else {
            startForeground(TtsNotifications.ID_ONGOING, n)
        }
    }

    private fun refreshNotification() {
        val session = mediaSession ?: return
        val nm = getSystemService(NOTIFICATION_SERVICE) as android.app.NotificationManager
        nm.notify(
            TtsNotifications.ID_ONGOING,
            TtsNotifications.ongoing(this, session, paused, mode == MODE_LOADING),
        )
        updatePlaybackState()
    }

    private fun startPlay(id: String, cwd: String, agentId: String) {
        generation += 1
        val gen = generation
        cancelWork()
        runId = id
        mode = MODE_LOADING
        phase = ""
        paused = false
        error = null
        writtenBytes = 0
        streamDone = false
        sampleRate = 24_000
        ShellBusy.setTtsPlaying(true)
        requestFocus()
        emit()
        refreshNotification()
        worker.execute {
            if (gen != generation) return@execute
            try {
                val origin = AppSettings.origin(this).trimEnd('/')
                if (origin.isEmpty()) throw IOException("empty origin")
                if (probeWav(origin, id)) {
                    playWav(origin, id, gen)
                } else {
                    playStream(origin, id, cwd, agentId, gen)
                }
            } catch (e: Exception) {
                if (gen != generation) return@execute
                Log.w(TAG, "play failed: ${e.message}")
                fail(e.message ?: "TTS 失败")
            }
        }
    }

    private fun probeWav(origin: String, id: String): Boolean {
        val req = Request.Builder().url("$origin/api/tts/${enc(id)}").head().build()
        HttpClient.okHttp.newCall(req).execute().use { resp ->
            return resp.isSuccessful
        }
    }

    private fun playWav(origin: String, id: String, gen: Int) {
        val req = Request.Builder().url("$origin/api/tts/${enc(id)}").get().build()
        val bytes = HttpClient.okHttp.newCall(req).execute().use { resp ->
            if (!resp.isSuccessful) throw IOException("http ${resp.code}")
            resp.body?.bytes() ?: throw IOException("empty wav")
        }
        if (gen != generation) return
        val file = File(cacheDir, "tts-$id.wav")
        file.writeBytes(bytes)
        main.post {
            if (gen != generation) return@post
            releaseOutputs()
            val mp = MediaPlayer()
            wavPlayer = mp
            mp.setAudioAttributes(mediaAttrs())
            mp.setDataSource(file.absolutePath)
            mp.setOnCompletionListener {
                if (gen != generation) return@setOnCompletionListener
                finishIdle()
            }
            mp.setOnErrorListener { _, what, extra ->
                Log.w(TAG, "MediaPlayer error $what $extra")
                fail("播放失败")
                true
            }
            mp.prepare()
            mp.start()
            mode = MODE_CACHED
            paused = false
            emit()
            refreshNotification()
            main.removeCallbacks(progressTick)
            main.post(progressTick)
        }
    }

    private fun playStream(origin: String, id: String, cwd: String, agentId: String, gen: Int) {
        val body = JSONObject()
            .put("cwd", cwd)
            .put("agentId", agentId)
            .put("runId", id)
            .toString()
            .toRequestBody(JSON)
        val req = Request.Builder().url("$origin/api/tts/stream").post(body).build()
        val call = HttpClient.sse.newCall(req)
        streamCall = call
        call.execute().use { resp ->
            if (gen != generation) return
            if (!resp.isSuccessful) {
                fail("TTS 请求失败 (${resp.code})")
                return
            }
            val src = resp.body?.source() ?: run {
                fail("empty body")
                return
            }
            SseReader.readFrames(src) { json ->
                if (gen != generation) return@readFrames false
                handleSse(json, gen)
            }
        }
        if (gen != generation) return
        if (mode == MODE_STREAMING && !paused) drainThenIdle(gen)
        else if (mode == MODE_STREAMING && paused) streamDone = true
        else if (mode == MODE_LOADING) fail("TTS 流中断")
    }

    private fun handleSse(json: JSONObject, gen: Int): Boolean {
        when (json.optString("type")) {
            "status" -> {
                phase = json.optString("phase")
                if (json.has("sampleRate")) {
                    val sr = json.optInt("sampleRate", sampleRate)
                    if (sr > 0) sampleRate = sr
                }
                if (phase == "synthesizing" && mode == MODE_LOADING) {
                    mode = MODE_STREAMING
                }
                emit()
                refreshNotification()
            }
            "audio" -> {
                val data = json.optString("data")
                if (data.isNotEmpty()) {
                    val first = mode != MODE_STREAMING
                    if (first) {
                        mode = MODE_STREAMING
                        emit()
                        refreshNotification()
                    }
                    writePcm(data)
                }
            }
            "done" -> {
                streamDone = true
                return false
            }
            "error" -> {
                fail(json.optString("message").ifEmpty { "TTS 失败" })
                return false
            }
        }
        return gen == generation
    }

    private fun ensureTrack() {
        if (track != null) return
        val min = AudioTrack.getMinBufferSize(
            sampleRate,
            AudioFormat.CHANNEL_OUT_MONO,
            AudioFormat.ENCODING_PCM_16BIT,
        ).coerceAtLeast(sampleRate)
        val t = AudioTrack.Builder()
            .setAudioAttributes(mediaAttrs())
            .setAudioFormat(
                AudioFormat.Builder()
                    .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                    .setSampleRate(sampleRate)
                    .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
                    .build(),
            )
            .setBufferSizeInBytes(min * 4)
            .setTransferMode(AudioTrack.MODE_STREAM)
            .build()
        track = t
        t.play()
    }

    private fun writePcm(b64: String) {
        val pcm = Base64.decode(b64, Base64.DEFAULT)
        if (track == null) ensureTrack()
        val t = track ?: return
        var off = 0
        while (off < pcm.size) {
            val n = t.write(pcm, off, pcm.size - off)
            if (n < 0) break
            off += n
            writtenBytes += n
        }
    }

    private fun drainThenIdle(gen: Int) {
        val t = track ?: run {
            if (gen == generation) finishIdle()
            return
        }
        val frames = writtenBytes / 2
        var spins = 0
        while (gen == generation && t.playState == AudioTrack.PLAYSTATE_PLAYING && spins < 400) {
            if (t.playbackHeadPosition >= frames - 1) break
            Thread.sleep(50)
            spins++
        }
        if (gen == generation) finishIdle()
    }

    private fun applyPause() {
        if (mode != MODE_STREAMING && mode != MODE_CACHED) return
        paused = true
        track?.pause()
        wavPlayer?.pause()
        emit()
        refreshNotification()
    }

    private fun applyResume() {
        if (mode != MODE_STREAMING && mode != MODE_CACHED) return
        paused = false
        track?.play()
        wavPlayer?.start()
        emit()
        refreshNotification()
        if (mode == MODE_CACHED) {
            main.removeCallbacks(progressTick)
            main.post(progressTick)
        }
        if (mode == MODE_STREAMING && streamDone) {
            val gen = generation
            worker.execute { drainThenIdle(gen) }
        }
    }

    private fun applyStop() {
        generation += 1
        finishIdle()
    }

    private fun applySeek(seconds: Double) {
        val mp = wavPlayer ?: return
        if (mode != MODE_CACHED) return
        val ms = (seconds * 1000).toInt().coerceIn(0, mp.duration.coerceAtLeast(0))
        mp.seekTo(ms)
        emit()
    }

    private fun fail(message: String) {
        error = message
        mode = MODE_ERROR
        paused = false
        generation += 1
        main.post {
            emit()
            cancelWork()
            releaseOutputs()
            abandonFocus()
            ShellBusy.setTtsPlaying(false)
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf()
        }
    }

    private fun finishIdle() {
        main.post {
            mode = MODE_IDLE
            paused = false
            phase = ""
            error = null
            emit()
            cancelWork()
            releaseOutputs()
            abandonFocus()
            ShellBusy.setTtsPlaying(false)
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf()
        }
    }

    private fun cancelWork() {
        streamCall?.cancel()
        streamCall = null
        main.removeCallbacks(progressTick)
    }

    private fun releaseOutputs() {
        try {
            track?.pause()
            track?.flush()
            track?.release()
        } catch (_: Exception) {
        }
        track = null
        try {
            wavPlayer?.reset()
            wavPlayer?.release()
        } catch (_: Exception) {
        }
        wavPlayer = null
        writtenBytes = 0
    }

    private fun requestFocus() {
        val am = getSystemService(AudioManager::class.java) ?: return
        abandonFocus()
        val req = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
            .setAudioAttributes(mediaAttrs())
            .setOnAudioFocusChangeListener { change ->
                if (change == AudioManager.AUDIOFOCUS_LOSS ||
                    change == AudioManager.AUDIOFOCUS_LOSS_TRANSIENT
                ) {
                    applyPause()
                }
            }
            .build()
        focusRequest = req
        am.requestAudioFocus(req)
    }

    private fun abandonFocus() {
        val req = focusRequest ?: return
        getSystemService(AudioManager::class.java)?.abandonAudioFocusRequest(req)
        focusRequest = null
    }

    private fun mediaAttrs(): AudioAttributes =
        AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_MEDIA)
            .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
            .build()

    private fun updatePlaybackState() {
        val session = mediaSession ?: return
        val state = when {
            mode == MODE_LOADING -> PlaybackState.STATE_BUFFERING
            mode == MODE_IDLE || mode == MODE_ERROR -> PlaybackState.STATE_STOPPED
            paused -> PlaybackState.STATE_PAUSED
            else -> PlaybackState.STATE_PLAYING
        }
        val pos = when {
            mode == MODE_CACHED -> (wavPlayer?.currentPosition ?: 0).toLong()
            else -> PlaybackState.PLAYBACK_POSITION_UNKNOWN
        }
        val actions =
            PlaybackState.ACTION_PLAY or PlaybackState.ACTION_PAUSE or
                PlaybackState.ACTION_STOP or PlaybackState.ACTION_SEEK_TO
        session.setPlaybackState(
            PlaybackState.Builder()
                .setActions(actions)
                .setState(state, pos, if (paused) 0f else 1f)
                .build(),
        )
    }

    private fun emit() {
        val json = JSONObject()
            .put("runId", runId)
            .put("mode", mode)
            .put("paused", paused)
            .put("phase", phase)
        error?.let { json.put("error", it) }
        val mp = wavPlayer
        if (mp != null && mode == MODE_CACHED) {
            val dur = mp.duration
            if (dur > 0) json.put("duration", dur / 1000.0)
            json.put("current", mp.currentPosition / 1000.0)
        }
        MainActivityBridge.dispatchTts(json)
        updatePlaybackState()
    }

    private fun enc(id: String) = java.net.URLEncoder.encode(id, "UTF-8")

    companion object {
        private const val TAG = "CwcTts"
        private val JSON = "application/json; charset=utf-8".toMediaType()
        const val ACTION_PLAY = "ltd.yooo.cursorwebchat.TTS_PLAY"
        const val ACTION_PAUSE = "ltd.yooo.cursorwebchat.TTS_PAUSE"
        const val ACTION_RESUME = "ltd.yooo.cursorwebchat.TTS_RESUME"
        const val ACTION_STOP = "ltd.yooo.cursorwebchat.TTS_STOP"
        const val ACTION_SEEK = "ltd.yooo.cursorwebchat.TTS_SEEK"
        const val EXTRA_RUN_ID = "runId"
        const val EXTRA_CWD = "cwd"
        const val EXTRA_AGENT_ID = "agentId"
        const val EXTRA_SEEK = "seek"
        private const val MODE_IDLE = "idle"
        private const val MODE_LOADING = "loading"
        private const val MODE_STREAMING = "streaming"
        private const val MODE_CACHED = "cached"
        private const val MODE_ERROR = "error"

        fun play(context: Context, runId: String, cwd: String, agentId: String) {
            val i = Intent(context, TtsPlaybackService::class.java)
                .setAction(ACTION_PLAY)
                .putExtra(EXTRA_RUN_ID, runId)
                .putExtra(EXTRA_CWD, cwd)
                .putExtra(EXTRA_AGENT_ID, agentId)
            start(context, i)
        }

        fun pause(context: Context) = start(context, Intent(context, TtsPlaybackService::class.java).setAction(ACTION_PAUSE))

        fun resume(context: Context) = start(context, Intent(context, TtsPlaybackService::class.java).setAction(ACTION_RESUME))

        fun stop(context: Context) = start(context, Intent(context, TtsPlaybackService::class.java).setAction(ACTION_STOP))

        fun seek(context: Context, seconds: Double) {
            val i = Intent(context, TtsPlaybackService::class.java)
                .setAction(ACTION_SEEK)
                .putExtra(EXTRA_SEEK, seconds)
            start(context, i)
        }

        private fun start(context: Context, i: Intent) {
            try {
                ContextCompat.startForegroundService(context, i)
            } catch (e: Exception) {
                Log.w(TAG, "start tts failed: ${e.message}")
            }
        }
    }
}

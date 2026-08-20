package ltd.yooo.cursorwebchat.run

import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.util.Log
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import ltd.yooo.cursorwebchat.AppSettings
import ltd.yooo.cursorwebchat.ShellBusy
import ltd.yooo.cursorwebchat.net.HttpClient
import ltd.yooo.cursorwebchat.net.SseReader
import okhttp3.Call
import okhttp3.Callback
import okhttp3.Request
import okhttp3.Response
import org.json.JSONObject
import java.io.IOException
import java.util.concurrent.ConcurrentHashMap

/**
 * 决策·fgs-split 的 Run 一半:本机发出的 live run 用 dataSync 前台服务挂
 * /api/agent/stream;进程被杀则本轮可以收不到(用户接受)。
 * 划掉进行中通知不等于 cancel。
 */
class RunWatchService : Service() {
    private val calls = ConcurrentHashMap<String, Call>()

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        RunNotifications.ensureChannels(this)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        promoteForeground()
        val agentId = intent?.getStringExtra(EXTRA_AGENT_ID)?.trim().orEmpty()
        when (intent?.action) {
            ACTION_WATCH -> if (agentId.isNotEmpty()) startWatch(agentId)
            ACTION_UNWATCH -> if (agentId.isNotEmpty()) stopWatch(agentId)
        }
        if (calls.isEmpty()) stopSelfSafely()
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        for (call in calls.values) call.cancel()
        calls.clear()
        noteWatchCount()
        super.onDestroy()
    }

    private fun promoteForeground() {
        val n = RunNotifications.ongoing(this, maxOf(calls.size, 1))
        if (Build.VERSION.SDK_INT >= 34) {
            startForeground(
                RunNotifications.ID_ONGOING,
                n,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC,
            )
        } else {
            startForeground(RunNotifications.ID_ONGOING, n)
        }
    }

    private fun refreshOngoing() {
        if (calls.isEmpty()) return
        NotificationManagerCompat.from(this).notify(
            RunNotifications.ID_ONGOING,
            RunNotifications.ongoing(this, calls.size),
        )
    }

    private fun startWatch(agentId: String) {
        if (calls.containsKey(agentId)) {
            refreshOngoing()
            return
        }
        connect(agentId, attempt = 0)
        refreshOngoing()
    }

    private fun stopWatch(agentId: String) {
        calls.remove(agentId)?.cancel()
        noteWatchCount()
        if (calls.isEmpty()) stopSelfSafely() else refreshOngoing()
    }

    private fun stopSelfSafely() {
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    private fun connect(agentId: String, attempt: Int) {
        val origin = AppSettings.origin(this)
        if (origin.isEmpty()) {
            Log.w(TAG, "watch $agentId skipped: empty origin")
            return
        }
        val url = "$origin/api/agent/stream?agentId=${java.net.URLEncoder.encode(agentId, "UTF-8")}"
        val req = Request.Builder().url(url).get().build()
        val call = HttpClient.sse.newCall(req)
        calls[agentId] = call
        noteWatchCount()
        call.enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) {
                if (call.isCanceled()) return
                retryOrDrop(agentId, attempt, e.message)
            }

            override fun onResponse(call: Call, response: Response) {
                response.use { resp ->
                    if (!resp.isSuccessful) {
                        val code = resp.code
                        if (code == 401 || code == 403) {
                            Log.w(TAG, "watch $agentId auth $code")
                            calls.remove(agentId)
                            noteWatchCount()
                            onTerminal(agentId, "error")
                            return
                        }
                        retryOrDrop(agentId, attempt, "http $code")
                        return
                    }
                    val body = resp.body ?: run {
                        retryOrDrop(agentId, attempt, "empty body")
                        return
                    }
                    try {
                        SseReader.readFrames(body.source()) { json ->
                            handleEvent(agentId, json)
                        }
                    } catch (e: IOException) {
                        if (call.isCanceled()) return
                        retryOrDrop(agentId, attempt, e.message)
                        return
                    }
                    if (calls.containsKey(agentId) && !call.isCanceled()) {
                        retryOrDrop(agentId, attempt, "eof")
                    }
                }
            }
        })
    }

    private fun handleEvent(agentId: String, json: JSONObject): Boolean {
        if (json.optString("type") != "done") return true
        val status = json.optString("status").ifEmpty { "unknown" }
        // 先从 map 拿掉,避免读循环结束后被当成 eof 去重连。
        calls.remove(agentId)
        noteWatchCount()
        onTerminal(agentId, status)
        return false
    }

    private fun retryOrDrop(agentId: String, attempt: Int, reason: String?) {
        if (!calls.containsKey(agentId)) return
        if (attempt >= MAX_RETRY) {
            Log.w(TAG, "watch $agentId give up after $attempt ($reason)")
            calls.remove(agentId)
            noteWatchCount()
            onTerminal(agentId, "unknown")
            return
        }
        val delay = (1000L shl attempt.coerceAtMost(4)).coerceAtMost(15_000L)
        Log.i(TAG, "watch $agentId retry ${attempt + 1} in ${delay}ms ($reason)")
        val handler = Handler(mainLooper)
        handler.postDelayed({
            if (!calls.containsKey(agentId)) return@postDelayed
            calls.remove(agentId)?.cancel()
            noteWatchCount()
            connect(agentId, attempt + 1)
        }, delay)
    }

    private fun onTerminal(agentId: String, status: String) {
        Handler(mainLooper).post {
            PendingRunTerminal.last = RunTerminal(agentId, status)
            // 决策·native-only-done-alert: 壳内结束只发系统通知,前台也发;网页不再叮咚。
            val chime = status == "finished" || status == "error" || status == "unknown"
            if (chime) {
                RunNotifications.ensureChannels(this)
                NotificationManagerCompat.from(this).notify(
                    RunNotifications.doneId(agentId),
                    RunNotifications.done(this, agentId, status),
                )
            }
            ltd.yooo.cursorwebchat.MainActivityBridge.dispatch(agentId, status)
            if (calls.isEmpty()) stopSelfSafely() else refreshOngoing()
        }
    }

    private fun noteWatchCount() {
        ShellBusy.setRunWatchCount(calls.size)
    }

    companion object {
        private const val TAG = "CwcRunWatch"
        private const val MAX_RETRY = 8
        const val ACTION_WATCH = "ltd.yooo.cursorwebchat.WATCH_RUN"
        const val ACTION_UNWATCH = "ltd.yooo.cursorwebchat.UNWATCH_RUN"
        const val EXTRA_AGENT_ID = "agentId"

        fun watch(context: Context, agentId: String) {
            val i = Intent(context, RunWatchService::class.java)
                .setAction(ACTION_WATCH)
                .putExtra(EXTRA_AGENT_ID, agentId)
            try {
                ContextCompat.startForegroundService(context, i)
            } catch (e: Exception) {
                Log.w(TAG, "start watch failed: ${e.message}")
            }
        }

        fun unwatch(context: Context, agentId: String) {
            val i = Intent(context, RunWatchService::class.java)
                .setAction(ACTION_UNWATCH)
                .putExtra(EXTRA_AGENT_ID, agentId)
            ContextCompat.startForegroundService(context, i)
        }
    }
}

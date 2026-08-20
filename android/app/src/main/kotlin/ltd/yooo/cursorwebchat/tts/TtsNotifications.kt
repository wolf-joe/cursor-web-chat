package ltd.yooo.cursorwebchat.tts

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.media.session.MediaSession
import android.os.Build
import ltd.yooo.cursorwebchat.MainActivity
import ltd.yooo.cursorwebchat.R

object TtsNotifications {
    const val CHANNEL_TTS = "tts_playback"
    const val ID_ONGOING = 1101

    fun ensureChannel(context: Context) {
        if (Build.VERSION.SDK_INT < 26) return
        val nm = context.getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(
            NotificationChannel(
                CHANNEL_TTS,
                context.getString(R.string.notify_channel_tts),
                NotificationManager.IMPORTANCE_LOW,
            ).apply {
                description = context.getString(R.string.notify_channel_tts_desc)
                setShowBadge(false)
                setSound(null, null)
                enableVibration(false)
            },
        )
    }

    fun ongoing(
        context: Context,
        session: MediaSession,
        paused: Boolean,
        loading: Boolean,
    ): Notification {
        val text = when {
            loading -> context.getString(R.string.notify_tts_loading)
            paused -> context.getString(R.string.notify_tts_paused)
            else -> context.getString(R.string.notify_tts_playing)
        }
        val toggleAction = if (paused) ACTION_RESUME else ACTION_PAUSE
        val toggleLabel = if (paused) {
            context.getString(R.string.notify_tts_resume)
        } else {
            context.getString(R.string.notify_tts_pause)
        }
        val toggleIcon = if (paused) {
            android.R.drawable.ic_media_play
        } else {
            android.R.drawable.ic_media_pause
        }
        val b = Notification.Builder(context, CHANNEL_TTS)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle(context.getString(R.string.app_name))
            .setContentText(text)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setContentIntent(openApp(context))
            .addAction(toggleIcon, toggleLabel, serviceIntent(context, toggleAction, 1))
            .addAction(
                android.R.drawable.ic_menu_close_clear_cancel,
                context.getString(R.string.notify_tts_stop),
                serviceIntent(context, ACTION_STOP, 2),
            )
            .setStyle(
                Notification.MediaStyle()
                    .setMediaSession(session.sessionToken)
                    .setShowActionsInCompactView(0, 1),
            )
            .setVisibility(Notification.VISIBILITY_PUBLIC)
        return b.build()
    }

    private fun serviceIntent(context: Context, action: String, req: Int): PendingIntent {
        val i = Intent(context, TtsPlaybackService::class.java).setAction(action)
        return PendingIntent.getForegroundService(
            context,
            req,
            i,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }

    private fun openApp(context: Context): PendingIntent {
        val intent = Intent(context, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        return PendingIntent.getActivity(
            context,
            11,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }

    const val ACTION_PAUSE = "ltd.yooo.cursorwebchat.TTS_PAUSE"
    const val ACTION_RESUME = "ltd.yooo.cursorwebchat.TTS_RESUME"
    const val ACTION_STOP = "ltd.yooo.cursorwebchat.TTS_STOP"
}

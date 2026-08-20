package ltd.yooo.cursorwebchat.run

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.media.AudioAttributes
import android.media.RingtoneManager
import android.os.Build
import androidx.core.app.NotificationCompat
import ltd.yooo.cursorwebchat.MainActivity
import ltd.yooo.cursorwebchat.R

object RunNotifications {
    const val CHANNEL_WATCH = "run_watch"
    const val CHANNEL_DONE = "run_done"
    const val ID_ONGOING = 1001

    fun ensureChannels(context: Context) {
        if (Build.VERSION.SDK_INT < 26) return
        val nm = context.getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(
            NotificationChannel(
                CHANNEL_WATCH,
                context.getString(R.string.notify_channel_watch),
                NotificationManager.IMPORTANCE_LOW,
            ).apply {
                description = context.getString(R.string.notify_channel_watch_desc)
                setShowBadge(false)
            },
        )
        val sound = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION)
        val attrs = AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_NOTIFICATION)
            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
            .build()
        nm.createNotificationChannel(
            NotificationChannel(
                CHANNEL_DONE,
                context.getString(R.string.notify_channel_done),
                NotificationManager.IMPORTANCE_HIGH,
            ).apply {
                description = context.getString(R.string.notify_channel_done_desc)
                enableVibration(false)
                setSound(sound, attrs)
            },
        )
    }

    fun ongoing(context: Context, watching: Int): Notification {
        val text = if (watching <= 1) {
            context.getString(R.string.notify_watch_text)
        } else {
            context.getString(R.string.notify_watch_text_n, watching)
        }
        return NotificationCompat.Builder(context, CHANNEL_WATCH)
            .setSmallIcon(android.R.drawable.stat_notify_sync)
            .setContentTitle(context.getString(R.string.app_name))
            .setContentText(text)
            .setOngoing(true)
            .setSilent(true)
            .setContentIntent(openApp(context, null))
            .build()
    }

    fun done(context: Context, agentId: String, status: String): Notification {
        val text = when (status) {
            "error" -> context.getString(R.string.notify_done_error)
            else -> context.getString(R.string.notify_done_ok)
        }
        return NotificationCompat.Builder(context, CHANNEL_DONE)
            .setSmallIcon(android.R.drawable.stat_notify_chat)
            .setContentTitle(context.getString(R.string.app_name))
            .setContentText(text)
            .setAutoCancel(true)
            .setOnlyAlertOnce(true)
            .setContentIntent(openApp(context, agentId))
            .build()
    }

    fun doneId(agentId: String): Int {
        return 2000 + (agentId.hashCode() and 0x0fff)
    }

    private fun openApp(context: Context, agentId: String?): PendingIntent {
        val intent = Intent(context, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
            if (agentId != null) putExtra(MainActivity.EXTRA_AGENT_ID, agentId)
        }
        return PendingIntent.getActivity(
            context,
            agentId?.hashCode() ?: 0,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }
}

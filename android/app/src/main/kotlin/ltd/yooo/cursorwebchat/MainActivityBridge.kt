package ltd.yooo.cursorwebchat

import java.lang.ref.WeakReference

/**
 * RunWatchService 在后台线程收到终态后转到 Activity,给 WebView 补 done。
 * Activity 不在则只靠 PendingRunTerminal,下次 onResume 再灌。
 */
object MainActivityBridge {
    @Volatile
    var instance: WeakReference<MainActivity>? = null

    fun dispatch(agentId: String, status: String) {
        val act = instance?.get() ?: return
        act.runOnUiThread { act.deliverRunTerminal(agentId, status) }
    }
}

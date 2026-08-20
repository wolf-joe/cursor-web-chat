package ltd.yooo.cursorwebchat

import java.lang.ref.WeakReference
import org.json.JSONObject

/**
 * RunWatchService / TtsPlaybackService 在后台线程收到状态后转到 Activity。
 * Activity 不在则记 last,下次 onPageFinished / onResume 再灌。
 */
object MainActivityBridge {
    @Volatile
    var instance: WeakReference<MainActivity>? = null

    @Volatile
    var lastTts: JSONObject? = null

    fun dispatch(agentId: String, status: String) {
        val act = instance?.get() ?: return
        act.runOnUiThread { act.deliverRunTerminal(agentId, status) }
    }

    fun dispatchTts(json: JSONObject) {
        lastTts = json
        val act = instance?.get() ?: return
        act.runOnUiThread { act.deliverTtsState(json) }
    }
}

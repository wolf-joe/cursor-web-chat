package ltd.yooo.cursorwebchat.net

import okio.BufferedSource
import org.json.JSONObject

/**
 * 最小 SSE 解析:只认 data 行与空行分帧;":" 注释(心跳)丢弃。
 * 业务事件形状以 /api/agent/stream 的 JSON 为准。
 */
object SseReader {
    /**
     * @return false 时停止读(调用方已处理终态或要取消)
     */
    fun readFrames(source: BufferedSource, onJson: (JSONObject) -> Boolean) {
        val data = StringBuilder()
        while (true) {
            val line = source.readUtf8Line() ?: break
            when {
                line.isEmpty() -> {
                    if (data.isNotEmpty()) {
                        val json = JSONObject(data.toString())
                        data.clear()
                        if (!onJson(json)) return
                    }
                }
                line.startsWith(":") -> Unit
                line.startsWith("data:") -> {
                    val payload = line.substring(5).trimStart()
                    if (data.isNotEmpty()) data.append('\n')
                    data.append(payload)
                }
            }
        }
        if (data.isNotEmpty()) {
            onJson(JSONObject(data.toString()))
        }
    }
}

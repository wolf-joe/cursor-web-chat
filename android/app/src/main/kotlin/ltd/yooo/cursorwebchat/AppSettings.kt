package ltd.yooo.cursorwebchat

import android.content.Context

/**
 * 决策·server-origin: WebView 与 OkHttp 共用可编辑 origin，禁止把 127.0.0.1 写进默认值。
 * 未决·default-origin: 预置现网网关，用户可在菜单里改。
 */
object AppSettings {
    private const val PREFS = "cwc_shell"
    private const val KEY_ORIGIN = "server_origin"
    const val DEFAULT_ORIGIN = "https://webchat.gateway.yooo.ltd"

    fun origin(context: Context): String {
        val stored = prefs(context).getString(KEY_ORIGIN, DEFAULT_ORIGIN)?.trim().orEmpty()
        val raw = stored.ifEmpty { DEFAULT_ORIGIN }
        return raw.trimEnd('/')
    }

    fun setOrigin(context: Context, origin: String) {
        prefs(context).edit().putString(KEY_ORIGIN, origin.trim().trimEnd('/')).apply()
    }

    fun isValidOrigin(raw: String): Boolean {
        val o = raw.trim()
        if (o.startsWith("http://127.0.0.1", ignoreCase = true)) return false
        if (o.startsWith("https://127.0.0.1", ignoreCase = true)) return false
        return o.startsWith("https://") || o.startsWith("http://")
    }

    private fun prefs(context: Context) =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
}

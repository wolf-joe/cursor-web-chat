package ltd.yooo.cursorwebchat

import android.content.Context
import android.util.Base64
import okhttp3.HttpUrl
import org.json.JSONObject
import java.nio.charset.StandardCharsets

/**
 * 决策·http-basic: Chromium WebView 对 WWW-Authenticate: Basic 默认 cancel,
 * 表现为 net::ERR_HTTP_RESPONSE_CODE_FAILURE;按 origin 存用户名密码,
 * WebView loadUrl 与 OkHttp 都预发 Authorization,不依赖系统弹窗。
 */
object HttpAuthStore {
    private const val PREFS = "cwc_shell"
    private const val KEY = "http_basic_by_origin"

    private lateinit var app: Context

    fun init(context: Context) {
        app = context.applicationContext
    }

    data class Creds(val user: String, val pass: String)

    fun get(origin: String): Creds? {
        val map = readMap()
        val obj = map.optJSONObject(AppSettings.normalize(origin)) ?: return null
        val user = obj.optString("user").trim()
        val pass = obj.optString("pass")
        if (user.isEmpty()) return null
        return Creds(user, pass)
    }

    fun put(origin: String, user: String, pass: String) {
        val key = AppSettings.normalize(origin)
        val map = readMap()
        if (user.trim().isEmpty()) {
            map.remove(key)
        } else {
            map.put(
                key,
                JSONObject().put("user", user.trim()).put("pass", pass),
            )
        }
        prefs().edit().putString(KEY, map.toString()).apply()
    }

    fun remove(origin: String) {
        val map = readMap()
        map.remove(AppSettings.normalize(origin))
        prefs().edit().putString(KEY, map.toString()).apply()
    }

    fun authorizationHeader(origin: String): String? {
        val creds = get(origin) ?: return null
        return encode(creds)
    }

    fun authorizationHeaderFor(url: HttpUrl): String? {
        val creds = get(originOf(url)) ?: return null
        return encode(creds)
    }

    fun originOf(url: HttpUrl): String {
        val defaultPort = if (url.scheme == "https") 443 else 80
        val hostPort =
            if (url.port == defaultPort) url.host else "${url.host}:${url.port}"
        return AppSettings.normalize("${url.scheme}://$hostPort")
    }

    fun extraHeaders(origin: String): Map<String, String>? {
        val header = authorizationHeader(origin) ?: return null
        return mapOf("Authorization" to header)
    }

    private fun encode(creds: Creds): String {
        val token = Base64.encodeToString(
            "${creds.user}:${creds.pass}".toByteArray(StandardCharsets.UTF_8),
            Base64.NO_WRAP,
        )
        return "Basic $token"
    }

    private fun readMap(): JSONObject {
        val raw = prefs().getString(KEY, null) ?: return JSONObject()
        return try {
            JSONObject(raw)
        } catch (_: org.json.JSONException) {
            JSONObject()
        }
    }

    private fun prefs() = app.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
}

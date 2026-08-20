package ltd.yooo.cursorwebchat.net

import android.webkit.CookieManager
import okhttp3.Cookie
import okhttp3.CookieJar
import okhttp3.HttpUrl

/**
 * 决策·shared-cookie: 原生 OkHttp 与 WebView 共用 CookieManager 里的 cwc_auth
 *（HttpOnly 对应用进程可读），不另做 Authorization 头。
 */
class SharedCookieJar : CookieJar {
    override fun loadForRequest(url: HttpUrl): List<Cookie> {
        val header = CookieManager.getInstance().getCookie(url.toString()) ?: return emptyList()
        return header.split(";").mapNotNull { part ->
            Cookie.parse(url, part.trim())
        }
    }

    override fun saveFromResponse(url: HttpUrl, cookies: List<Cookie>) {
        val cm = CookieManager.getInstance()
        for (cookie in cookies) {
            cm.setCookie(url.toString(), cookie.toString())
        }
        cm.flush()
    }
}

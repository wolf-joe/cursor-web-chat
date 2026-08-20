package ltd.yooo.cursorwebchat.net

import android.util.Log
import okhttp3.OkHttpClient
import okhttp3.Request
import java.util.concurrent.TimeUnit

object HttpClient {
    private const val TAG = "CwcHttp"

    lateinit var okHttp: OkHttpClient
        private set

    fun init() {
        okHttp = OkHttpClient.Builder()
            .cookieJar(SharedCookieJar())
            .connectTimeout(30, TimeUnit.SECONDS)
            .readTimeout(30, TimeUnit.SECONDS)
            .build()
    }

    /** 登录后探测原生是否带上 cwc_auth；401 只打日志，不打扰 UI。 */
    fun probeAuth(origin: String) {
        val client = okHttp
        val url = "${origin.trimEnd('/')}/api/folders"
        client.newCall(Request.Builder().url(url).get().build()).enqueue(object : okhttp3.Callback {
            override fun onFailure(call: okhttp3.Call, e: java.io.IOException) {
                Log.w(TAG, "probe $url failed: ${e.message}")
            }

            override fun onResponse(call: okhttp3.Call, response: okhttp3.Response) {
                response.use {
                    val sent = call.request().header("Cookie") ?: ""
                    val hasAuth = sent.contains("cwc_auth=")
                    Log.i(TAG, "probe $url -> ${it.code} cookieHasCwcAuth=$hasAuth")
                }
            }
        })
    }
}

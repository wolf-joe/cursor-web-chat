package ltd.yooo.cursorwebchat.net

import android.util.Log
import ltd.yooo.cursorwebchat.HttpAuthStore
import okhttp3.Interceptor
import okhttp3.OkHttpClient
import okhttp3.Request
import java.util.concurrent.TimeUnit

object HttpClient {
    private const val TAG = "CwcHttp"

    lateinit var okHttp: OkHttpClient
        private set

    lateinit var sse: OkHttpClient
        private set

    fun init() {
        val basicAuth = Interceptor { chain ->
            val req = chain.request()
            if (req.header("Authorization") != null) return@Interceptor chain.proceed(req)
            val header = HttpAuthStore.authorizationHeaderFor(req.url)
                ?: return@Interceptor chain.proceed(req)
            chain.proceed(req.newBuilder().header("Authorization", header).build())
        }
        okHttp = OkHttpClient.Builder()
            .cookieJar(SharedCookieJar())
            .addInterceptor(basicAuth)
            .connectTimeout(30, TimeUnit.SECONDS)
            .readTimeout(30, TimeUnit.SECONDS)
            .build()
        // SSE 必须取消读超时;短探测仍用上面的 30s。
        sse = okHttp.newBuilder()
            .readTimeout(0, TimeUnit.MILLISECONDS)
            .callTimeout(0, TimeUnit.MILLISECONDS)
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

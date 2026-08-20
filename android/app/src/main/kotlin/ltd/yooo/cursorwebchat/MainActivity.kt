package ltd.yooo.cursorwebchat

import android.Manifest
import android.annotation.SuppressLint
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Bundle
import android.os.Message
import android.webkit.CookieManager
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.ImageButton
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.core.view.updateLayoutParams
import ltd.yooo.cursorwebchat.net.HttpClient
import ltd.yooo.cursorwebchat.run.PendingRunTerminal
import ltd.yooo.cursorwebchat.run.RunWatchService
import org.json.JSONObject
import java.lang.ref.WeakReference

class MainActivity : AppCompatActivity() {
    private lateinit var webView: WebView
    private var loadedOrigin: String? = null
    // 决策·clear-history: 仅 origin 变更后的那次 onPageFinished 清栈,同站刷新不清。
    private var pendingClearHistory = false

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        MainActivityBridge.instance = WeakReference(this)
        WindowCompat.setDecorFitsSystemWindows(window, false)
        setContentView(R.layout.activity_main)

        val root = findViewById<FrameLayout>(R.id.root)
        webView = findViewById(R.id.webview)
        val fab = findViewById<ImageButton>(R.id.btn_shell_settings)
        WindowInsetsControllerCompat(window, window.decorView).apply {
            isAppearanceLightStatusBars = true
            isAppearanceLightNavigationBars = true
        }
        val density = resources.displayMetrics.density
        ViewCompat.setOnApplyWindowInsetsListener(root) { v, insets ->
            val sys = insets.getInsets(
                WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout(),
            )
            val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
            // 容器留白:顶避开状态栏,底避开手势条;IME 起来时底边跟键盘走(edge-to-edge 下 adjustResize 无效)。
            v.setPadding(sys.left, sys.top, sys.right, maxOf(sys.bottom, ime.bottom))
            fab.updateLayoutParams<FrameLayout.LayoutParams> {
                topMargin = (56 * density).toInt()
                marginEnd = (8 * density).toInt()
            }
            WindowInsetsCompat.CONSUMED
        }

        CookieManager.getInstance().setAcceptThirdPartyCookies(webView, true)
        if (BuildConfig.DEBUG) {
            WebView.setWebContentsDebuggingEnabled(true)
        }

        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            cacheMode = WebSettings.LOAD_DEFAULT
            mixedContentMode = WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE
            mediaPlaybackRequiresUserGesture = false
            javaScriptCanOpenWindowsAutomatically = true
            setSupportMultipleWindows(true)
            setSupportZoom(true)
            builtInZoomControls = true
            displayZoomControls = false
            useWideViewPort = true
            loadWithOverviewMode = true
        }
        // 决策·native-watch-own-send: 只暴露 watch/unwatch;页面发消息后才订原生 SSE。
        webView.addJavascriptInterface(CwcNativeBridge(), "CwcNative")
        webView.webChromeClient = object : WebChromeClient() {
            override fun onCreateWindow(
                view: WebView,
                isDialog: Boolean,
                isUserGesture: Boolean,
                resultMsg: Message,
            ): Boolean {
                val dummy = WebView(view.context)
                dummy.webViewClient = object : WebViewClient() {
                    override fun shouldOverrideUrlLoading(v: WebView, request: WebResourceRequest): Boolean {
                        openInBrowser(request.url)
                        return true
                    }
                }
                val transport = resultMsg.obj as WebView.WebViewTransport
                transport.webView = dummy
                resultMsg.sendToTarget()
                return true
            }
        }
        webView.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val url = request.url
                if (isSameOrigin(url)) return false
                openInBrowser(url)
                return true
            }

            override fun onPageFinished(view: WebView, url: String) {
                CookieManager.getInstance().flush()
                if (pendingClearHistory) {
                    view.clearHistory()
                    pendingClearHistory = false
                }
                HttpClient.probeAuth(AppSettings.origin(this@MainActivity))
                flushPendingTerminal()
            }
        }
        webView.setDownloadListener { url, _, _, _, _ ->
            openInBrowser(Uri.parse(url))
        }

        fab.setOnClickListener {
            startActivity(Intent(this, SettingsActivity::class.java))
        }

        if (savedInstanceState != null) {
            webView.restoreState(savedInstanceState)
            loadedOrigin = AppSettings.origin(this)
        } else {
            loadOrigin()
        }

        requestNotificationPermission()

        onBackPressedDispatcher.addCallback(
            this,
            object : OnBackPressedCallback(true) {
                override fun handleOnBackPressed() {
                    if (webView.canGoBack()) {
                        webView.goBack()
                    } else {
                        isEnabled = false
                        onBackPressedDispatcher.onBackPressed()
                    }
                }
            },
        )
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        webView.saveState(outState)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        flushPendingTerminal()
    }

    override fun onResume() {
        super.onResume()
        CookieManager.getInstance().flush()
        val origin = AppSettings.origin(this)
        if (loadedOrigin != null && loadedOrigin != origin) {
            loadOrigin()
        }
        flushPendingTerminal()
    }

    override fun onDestroy() {
        if (MainActivityBridge.instance?.get() === this) {
            MainActivityBridge.instance = null
        }
        super.onDestroy()
    }

    fun deliverRunTerminal(agentId: String, status: String) {
        if (!::webView.isInitialized) return
        val js =
            "window.__cwcOnRunTerminal && window.__cwcOnRunTerminal(${JSONObject.quote(agentId)}, ${JSONObject.quote(status)});"
        webView.evaluateJavascript(js, null)
    }

    fun reloadPage() {
        runOnUiThread {
            if (::webView.isInitialized) webView.reload()
        }
    }

    private fun flushPendingTerminal() {
        val pending = PendingRunTerminal.last ?: return
        deliverRunTerminal(pending.agentId, pending.status)
        PendingRunTerminal.last = null
    }

    private fun requestNotificationPermission() {
        if (android.os.Build.VERSION.SDK_INT < 33) return
        val granted = ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) ==
            PackageManager.PERMISSION_GRANTED
        if (!granted) {
            ActivityCompat.requestPermissions(this, arrayOf(Manifest.permission.POST_NOTIFICATIONS), REQ_NOTIFY)
        }
    }

    private fun loadOrigin() {
        val origin = AppSettings.origin(this)
        pendingClearHistory = loadedOrigin != null && loadedOrigin != origin
        loadedOrigin = origin
        webView.loadUrl(origin)
    }

    private fun isSameOrigin(url: Uri): Boolean {
        val origin = Uri.parse(AppSettings.origin(this))
        if (!origin.scheme.equals(url.scheme, ignoreCase = true)) return false
        if (!origin.host.equals(url.host, ignoreCase = true)) return false
        return effectivePort(origin) == effectivePort(url)
    }

    private fun effectivePort(uri: Uri): Int {
        if (uri.port != -1) return uri.port
        return when (uri.scheme?.lowercase()) {
            "https" -> 443
            "http" -> 80
            else -> -1
        }
    }

    private fun openInBrowser(url: Uri) {
        val scheme = url.scheme?.lowercase()
        if (scheme != "http" && scheme != "https") return
        try {
            startActivity(Intent(Intent.ACTION_VIEW, url))
        } catch (_: ActivityNotFoundException) {
            Toast.makeText(this, R.string.open_external_failed, Toast.LENGTH_SHORT).show()
        }
    }

    inner class CwcNativeBridge {
        @JavascriptInterface
        fun watchRun(agentId: String?) {
            val id = agentId?.trim().orEmpty()
            if (id.isEmpty()) return
            val pending = PendingRunTerminal.last
            if (pending?.agentId == id) PendingRunTerminal.last = null
            RunWatchService.watch(this@MainActivity, id)
        }

        @JavascriptInterface
        fun unwatchRun(agentId: String?) {
            val id = agentId?.trim().orEmpty()
            if (id.isEmpty()) return
            RunWatchService.unwatch(this@MainActivity, id)
        }
    }

    companion object {
        const val EXTRA_AGENT_ID = "agentId"
        private const val REQ_NOTIFY = 41
    }
}

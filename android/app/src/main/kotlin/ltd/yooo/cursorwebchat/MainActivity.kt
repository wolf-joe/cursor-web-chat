package ltd.yooo.cursorwebchat

import android.Manifest
import android.annotation.SuppressLint
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Message
import android.view.Menu
import android.view.MenuItem
import android.webkit.CookieManager
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.appcompat.widget.Toolbar
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import ltd.yooo.cursorwebchat.net.HttpClient
import ltd.yooo.cursorwebchat.run.PendingRunTerminal
import ltd.yooo.cursorwebchat.run.RunWatchService
import org.json.JSONObject
import java.lang.ref.WeakReference

class MainActivity : AppCompatActivity() {
    private lateinit var webView: WebView

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        MainActivityBridge.instance = WeakReference(this)
        WindowCompat.setDecorFitsSystemWindows(window, false)
        setContentView(R.layout.activity_main)

        val root = findViewById<LinearLayout>(R.id.root)
        val toolbar = findViewById<Toolbar>(R.id.toolbar)
        webView = findViewById(R.id.webview)
        setSupportActionBar(toolbar)
        WindowInsetsControllerCompat(window, window.decorView).apply {
            isAppearanceLightStatusBars = false
            isAppearanceLightNavigationBars = true
        }
        ViewCompat.setOnApplyWindowInsetsListener(root) { v, insets ->
            val bars = insets.getInsets(
                WindowInsetsCompat.Type.statusBars() or WindowInsetsCompat.Type.displayCutout(),
            )
            v.setPadding(bars.left, bars.top, bars.right, 0)
            insets
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
                HttpClient.probeAuth(AppSettings.origin(this@MainActivity))
                flushPendingTerminal()
            }
        }
        webView.setDownloadListener { url, _, _, _, _ ->
            openInBrowser(Uri.parse(url))
        }

        if (savedInstanceState != null) {
            webView.restoreState(savedInstanceState)
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
        flushPendingTerminal()
    }

    override fun onDestroy() {
        if (MainActivityBridge.instance?.get() === this) {
            MainActivityBridge.instance = null
        }
        super.onDestroy()
    }

    override fun onCreateOptionsMenu(menu: Menu): Boolean {
        menuInflater.inflate(R.menu.main, menu)
        return true
    }

    override fun onOptionsItemSelected(item: MenuItem): Boolean {
        return when (item.itemId) {
            R.id.action_reload -> {
                webView.reload()
                true
            }
            R.id.action_origin -> {
                showOriginDialog()
                true
            }
            else -> super.onOptionsItemSelected(item)
        }
    }

    fun deliverRunTerminal(agentId: String, status: String) {
        if (!::webView.isInitialized) return
        val js =
            "window.__cwcOnRunTerminal && window.__cwcOnRunTerminal(${JSONObject.quote(agentId)}, ${JSONObject.quote(status)});"
        webView.evaluateJavascript(js, null)
    }

    private fun flushPendingTerminal() {
        val pending = PendingRunTerminal.last ?: return
        deliverRunTerminal(pending.agentId, pending.status)
        PendingRunTerminal.last = null
    }

    private fun requestNotificationPermission() {
        if (Build.VERSION.SDK_INT < 33) return
        val granted = ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) ==
            PackageManager.PERMISSION_GRANTED
        if (!granted) {
            ActivityCompat.requestPermissions(this, arrayOf(Manifest.permission.POST_NOTIFICATIONS), REQ_NOTIFY)
        }
    }

    private fun loadOrigin() {
        webView.loadUrl(AppSettings.origin(this))
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

    private fun showOriginDialog() {
        val input = EditText(this).apply {
            setText(AppSettings.origin(this@MainActivity))
            hint = getString(R.string.origin_hint)
            setSingleLine()
        }
        val pad = (16 * resources.displayMetrics.density).toInt()
        val wrap = FrameLayout(this).apply {
            setPadding(pad, pad / 2, pad, 0)
            addView(input)
        }
        AlertDialog.Builder(this)
            .setTitle(R.string.origin_title)
            .setMessage(R.string.origin_message)
            .setView(wrap)
            .setNegativeButton(R.string.origin_cancel, null)
            .setPositiveButton(R.string.origin_save) { _, _ ->
                val raw = input.text.toString()
                if (!AppSettings.isValidOrigin(raw)) {
                    Toast.makeText(this, R.string.origin_invalid, Toast.LENGTH_LONG).show()
                    return@setPositiveButton
                }
                AppSettings.setOrigin(this, raw)
                loadOrigin()
            }
            .show()
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

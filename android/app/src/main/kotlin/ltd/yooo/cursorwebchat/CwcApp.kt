package ltd.yooo.cursorwebchat

import android.app.Application
import android.webkit.CookieManager
import ltd.yooo.cursorwebchat.net.HttpClient

class CwcApp : Application() {
    override fun onCreate() {
        super.onCreate()
        CookieManager.getInstance().setAcceptCookie(true)
        HttpClient.init()
    }
}

package ltd.yooo.cursorwebchat

import android.os.Bundle
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.appcompat.widget.Toolbar
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat

class SettingsActivity : AppCompatActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WindowCompat.setDecorFitsSystemWindows(window, false)
        setContentView(R.layout.activity_settings)

        WindowInsetsControllerCompat(window, window.decorView).apply {
            isAppearanceLightStatusBars = true
            isAppearanceLightNavigationBars = true
        }

        val root = findViewById<LinearLayout>(R.id.settings_root)
        ViewCompat.setOnApplyWindowInsetsListener(root) { v, insets ->
            val sys = insets.getInsets(
                WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout(),
            )
            val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
            v.setPadding(sys.left, sys.top, sys.right, maxOf(sys.bottom, ime.bottom))
            WindowInsetsCompat.CONSUMED
        }

        val toolbar = findViewById<Toolbar>(R.id.settings_toolbar)
        setSupportActionBar(toolbar)
        toolbar.setNavigationOnClickListener { finish() }
        supportActionBar?.setDisplayHomeAsUpEnabled(true)

        val input = findViewById<EditText>(R.id.origin_input)
        input.setText(AppSettings.origin(this))

        findViewById<Button>(R.id.origin_save).setOnClickListener {
            val raw = input.text.toString()
            if (!AppSettings.isValidOrigin(raw)) {
                Toast.makeText(this, R.string.origin_invalid, Toast.LENGTH_LONG).show()
                return@setOnClickListener
            }
            AppSettings.setOrigin(this, raw)
            Toast.makeText(this, R.string.origin_saved, Toast.LENGTH_SHORT).show()
            finish()
        }

        findViewById<Button>(R.id.page_reload).setOnClickListener {
            MainActivityBridge.instance?.get()?.reloadPage()
            finish()
        }
    }
}

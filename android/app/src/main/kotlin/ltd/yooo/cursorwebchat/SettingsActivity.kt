package ltd.yooo.cursorwebchat

import android.os.Bundle
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.appcompat.widget.Toolbar
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat

class SettingsActivity : AppCompatActivity() {
    private lateinit var list: LinearLayout
    private lateinit var input: EditText

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

        list = findViewById(R.id.origin_list)
        input = findViewById(R.id.origin_input)
        renderList()

        findViewById<Button>(R.id.origin_add).setOnClickListener {
            when (AppSettings.addOrigin(this, input.text.toString())) {
                AddOriginResult.Ok -> {
                    input.text.clear()
                    Toast.makeText(this, R.string.origin_added, Toast.LENGTH_SHORT).show()
                    renderList()
                }
                AddOriginResult.Invalid ->
                    Toast.makeText(this, R.string.origin_invalid, Toast.LENGTH_LONG).show()
                AddOriginResult.Duplicate ->
                    Toast.makeText(this, R.string.origin_duplicate, Toast.LENGTH_SHORT).show()
            }
        }

        findViewById<Button>(R.id.page_reload).setOnClickListener {
            MainActivityBridge.instance?.get()?.reloadPage()
            finish()
        }
    }

    private fun renderList() {
        list.removeAllViews()
        val current = AppSettings.origin(this)
        for (url in AppSettings.origins(this)) {
            val row = layoutInflater.inflate(R.layout.item_origin, list, false)
            row.findViewById<TextView>(R.id.origin_url).text = url
            val mark = row.findViewById<TextView>(R.id.origin_current_mark)
            val delete = row.findViewById<Button>(R.id.origin_delete)
            val isCurrent = url == current
            mark.visibility = if (isCurrent) View.VISIBLE else View.GONE
            delete.visibility = if (isCurrent) View.GONE else View.VISIBLE
            row.findViewById<View>(R.id.origin_row_main).setOnClickListener {
                selectOrigin(url)
            }
            delete.setOnClickListener {
                when (AppSettings.removeOrigin(this, url)) {
                    RemoveOriginResult.Ok -> renderList()
                    RemoveOriginResult.IsCurrent ->
                        Toast.makeText(this, R.string.origin_cannot_delete_current, Toast.LENGTH_SHORT).show()
                    RemoveOriginResult.NotFound -> renderList()
                }
            }
            list.addView(row)
        }
    }

    private fun selectOrigin(url: String) {
        if (url == AppSettings.origin(this)) return
        when (AppSettings.setCurrent(this, url)) {
            SetCurrentResult.Ok -> {
                Toast.makeText(this, R.string.origin_saved, Toast.LENGTH_SHORT).show()
                finish()
            }
            SetCurrentResult.Busy ->
                Toast.makeText(this, R.string.origin_busy, Toast.LENGTH_LONG).show()
            SetCurrentResult.Invalid, SetCurrentResult.NotInList ->
                Toast.makeText(this, R.string.origin_invalid, Toast.LENGTH_LONG).show()
        }
    }
}

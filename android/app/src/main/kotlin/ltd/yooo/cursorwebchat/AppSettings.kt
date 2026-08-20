package ltd.yooo.cursorwebchat

import android.content.Context
import android.content.SharedPreferences
import org.json.JSONArray

/**
 * 决策·server-origin / 决策·url-only: WebView 与 OkHttp 共用当前 origin;
 * 设置页另存规范化 URL 列表。禁止把 127.0.0.1 写进默认值。
 */
object AppSettings {
    private const val PREFS = "cwc_shell"
    private const val KEY_ORIGIN = "server_origin"
    private const val KEY_ORIGINS = "server_origins"
    const val DEFAULT_ORIGIN = "https://webchat.gateway.yooo.ltd"

    fun origin(context: Context): String {
        ensureConsistent(context)
        return prefs(context).getString(KEY_ORIGIN, DEFAULT_ORIGIN)!!.let { normalize(it) }
    }

    fun origins(context: Context): List<String> {
        ensureConsistent(context)
        return readList(prefs(context))
    }

    fun setCurrent(context: Context, raw: String): SetCurrentResult {
        val next = normalize(raw)
        if (!isValidOrigin(next)) return SetCurrentResult.Invalid
        ensureConsistent(context)
        val current = origin(context)
        if (next == current) return SetCurrentResult.Ok
        if (next !in readList(prefs(context))) return SetCurrentResult.NotInList
        // 决策·busy-gate: 真正改当前项前当场查,不用打开设置那一刻的缓存。
        if (ShellBusy.isBusy()) return SetCurrentResult.Busy
        prefs(context).edit().putString(KEY_ORIGIN, next).apply()
        return SetCurrentResult.Ok
    }

    fun addOrigin(context: Context, raw: String): AddOriginResult {
        if (!isValidOrigin(raw)) return AddOriginResult.Invalid
        val next = normalize(raw)
        ensureConsistent(context)
        val p = prefs(context)
        val list = readList(p).toMutableList()
        if (list.any { it == next }) return AddOriginResult.Duplicate
        list.add(next)
        writeList(p, list)
        return AddOriginResult.Ok
    }

    fun removeOrigin(context: Context, raw: String): RemoveOriginResult {
        val target = normalize(raw)
        ensureConsistent(context)
        val p = prefs(context)
        val current = origin(context)
        // 决策·keep-one: 禁止删当前项,列表至少留一条。
        if (target == current) return RemoveOriginResult.IsCurrent
        val list = readList(p).toMutableList()
        if (!list.remove(target)) return RemoveOriginResult.NotFound
        if (list.isEmpty()) {
            list.add(DEFAULT_ORIGIN)
            p.edit().putString(KEY_ORIGIN, DEFAULT_ORIGIN).apply()
        }
        writeList(p, list)
        HttpAuthStore.remove(target)
        return RemoveOriginResult.Ok
    }

    fun isValidOrigin(raw: String): Boolean {
        val o = raw.trim()
        if (o.startsWith("http://127.0.0.1", ignoreCase = true)) return false
        if (o.startsWith("https://127.0.0.1", ignoreCase = true)) return false
        return o.startsWith("https://") || o.startsWith("http://")
    }

    fun normalize(raw: String): String = raw.trim().trimEnd('/')

    private fun ensureConsistent(context: Context) {
        val p = prefs(context)
        val existingList = if (p.contains(KEY_ORIGINS)) readList(p) else null
        // 决策·migrate-single: 旧版只有 server_origin 时迁进数组。
        val migrated = existingList == null
        val fromLegacy = p.getString(KEY_ORIGIN, null)?.let { normalize(it) }.orEmpty()
        val seed = when {
            !migrated -> null
            fromLegacy.isNotEmpty() && isValidOrigin(fromLegacy) -> fromLegacy
            else -> DEFAULT_ORIGIN
        }
        var list = (existingList ?: listOfNotNull(seed))
            .map { normalize(it) }
            .filter { isValidOrigin(it) }
            .distinct()
        if (list.isEmpty()) list = listOf(DEFAULT_ORIGIN)
        var current = p.getString(KEY_ORIGIN, null)?.let { normalize(it) }.orEmpty()
        if (current.isEmpty() || current !in list) current = list.first()
        if (migrated || existingList != list) writeList(p, list)
        if (p.getString(KEY_ORIGIN, null) != current) {
            p.edit().putString(KEY_ORIGIN, current).apply()
        }
    }

    private fun readList(p: SharedPreferences): List<String> {
        val raw = p.getString(KEY_ORIGINS, null) ?: return emptyList()
        return try {
            val arr = JSONArray(raw)
            buildList {
                for (i in 0 until arr.length()) {
                    val item = arr.optString(i, "").let { normalize(it) }
                    if (item.isNotEmpty()) add(item)
                }
            }
        } catch (_: Exception) {
            emptyList()
        }
    }

    private fun writeList(p: SharedPreferences, list: List<String>) {
        val arr = JSONArray()
        for (item in list) arr.put(item)
        p.edit().putString(KEY_ORIGINS, arr.toString()).apply()
    }

    private fun prefs(context: Context) =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
}

enum class SetCurrentResult { Ok, Busy, NotInList, Invalid }

enum class AddOriginResult { Ok, Invalid, Duplicate }

enum class RemoveOriginResult { Ok, IsCurrent, NotFound }

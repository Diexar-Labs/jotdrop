package com.diexar.keepcapture

import android.content.Context
import androidx.preference.PreferenceManager
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

data class UpdateInfo(val version: String, val url: String)

/**
 * Lichtgewicht update-check tegen de GitHub Releases-API. Geen extra libs:
 * HttpURLConnection + org.json (beide in de Android-runtime). Faalt stil bij
 * netwerk-/parse-problemen zodat het nooit de app stoort.
 */
object UpdateChecker {
    private const val LATEST_RELEASE_API =
        "https://api.github.com/repos/Diexar-Labs/jotdrop/releases/latest"
    private const val KEY_LAST_CHECK = "update_last_check_ms"
    private const val KEY_DISMISSED = "update_dismissed_version"
    private const val CHECK_INTERVAL_MS = 24L * 60 * 60 * 1000 // 1x per dag

    /**
     * Geeft [UpdateInfo] terug als er een nieuwere release is dan de
     * geïnstalleerde versie, anders null. Zonder [force] hooguit 1x per dag
     * netwerk-verkeer (throttle via prefs).
     */
    suspend fun check(context: Context, force: Boolean): UpdateInfo? {
        val prefs = PreferenceManager.getDefaultSharedPreferences(context)
        val now = System.currentTimeMillis()
        if (!force && now - prefs.getLong(KEY_LAST_CHECK, 0L) < CHECK_INTERVAL_MS) return null
        val installed = installedVersion(context) ?: return null
        val latest = withContext(Dispatchers.IO) { fetchLatest() } ?: return null
        prefs.edit().putLong(KEY_LAST_CHECK, now).apply()
        return if (isNewer(latest.version, installed)) latest else null
    }

    fun isDismissed(context: Context, version: String): Boolean =
        PreferenceManager.getDefaultSharedPreferences(context)
            .getString(KEY_DISMISSED, null) == version

    fun dismiss(context: Context, version: String) {
        PreferenceManager.getDefaultSharedPreferences(context)
            .edit().putString(KEY_DISMISSED, version).apply()
    }

    fun installedVersion(context: Context): String? = try {
        context.packageManager.getPackageInfo(context.packageName, 0).versionName
    } catch (_: Exception) {
        null
    }

    private fun fetchLatest(): UpdateInfo? {
        var conn: HttpURLConnection? = null
        return try {
            conn = (URL(LATEST_RELEASE_API).openConnection() as HttpURLConnection).apply {
                requestMethod = "GET"
                connectTimeout = 8000
                readTimeout = 8000
                setRequestProperty("Accept", "application/vnd.github+json")
                setRequestProperty("User-Agent", "JotDrop-Android")
            }
            if (conn.responseCode != 200) return null
            val body = conn.inputStream.bufferedReader().use { it.readText() }
            val json = JSONObject(body)
            val tag = json.optString("tag_name").trim()
            val url = json.optString("html_url").trim()
            if (tag.isEmpty() || url.isEmpty()) null
            else UpdateInfo(version = tag.removePrefix("v"), url = url)
        } catch (_: Exception) {
            null
        } finally {
            conn?.disconnect()
        }
    }

    /** True als [latest] semantisch hoger is dan [installed] (major.minor.patch). */
    private fun isNewer(latest: String, installed: String): Boolean {
        val a = parse(latest)
        val b = parse(installed)
        for (i in 0 until maxOf(a.size, b.size)) {
            val x = a.getOrElse(i) { 0 }
            val y = b.getOrElse(i) { 0 }
            if (x != y) return x > y
        }
        return false
    }

    private fun parse(v: String): List<Int> =
        v.trim().removePrefix("v").split(".")
            .map { it.takeWhile(Char::isDigit).toIntOrNull() ?: 0 }
}

package com.diexar.keepcapture

import android.app.UiModeManager
import android.content.Context
import android.content.res.Configuration
import android.os.Build
import androidx.activity.ComponentActivity
import androidx.appcompat.app.AppCompatActivity
import androidx.appcompat.app.AppCompatDelegate

/**
 * In-app theme choice (Settings > Theme): System, Light or Dark.
 *
 * Android 12+ (API 31+): [UiModeManager.setApplicationNightMode] stores the choice in the system for
 * this app only. The system then hands every activity, the Application context and the splash screen a
 * configuration with the chosen night mode, so `isSystemInDarkTheme()`, DayNight resources and the
 * status bar icon contrast follow it without further work. A change recreates the open screens.
 *
 * Android 8 to 11 (API 26-30): no such API. AppCompat screens get the mode via
 * [AppCompatDelegate.setDefaultNightMode]; the Compose screens ([ThemedComponentActivity]) get an
 * override configuration in attachBaseContext and recreate themselves when they come back to the front
 * after the choice changed.
 *
 * Home screen widgets are not affected: they use fixed paper-and-ink colors.
 */
object AppTheme {
    private val usesSystemApi get() = Build.VERSION.SDK_INT >= Build.VERSION_CODES.S

    @Volatile private var syncedThisProcess = false

    /** Saves the choice and applies it to the whole app right away. */
    fun save(context: Context, choice: ThemeChoice) {
        Storage.saveThemeChoice(context, choice)
        if (usesSystemApi) {
            setSystemNightMode(context, choice)
        } else {
            // Recreates open AppCompat screens; Compose screens recreate on their next onRestart.
            AppCompatDelegate.setDefaultNightMode(appCompatMode(choice))
        }
    }

    /**
     * Call from attachBaseContext, before super. Returns the choice this screen is built with.
     * Also repairs a lost system setting once per process (for example after a backup restore
     * brought the preference back but not the system's per-app night mode).
     */
    fun prepare(base: Context): ThemeChoice {
        val choice = Storage.getThemeChoice(base)
        if (usesSystemApi) {
            if (!syncedThisProcess) {
                syncedThisProcess = true
                val wantNight = when (choice) {
                    ThemeChoice.DARK -> true
                    ThemeChoice.LIGHT -> false
                    ThemeChoice.SYSTEM -> null
                }
                if (wantNight != null && isNight(base.resources.configuration) != wantNight) {
                    setSystemNightMode(base, choice)
                }
            }
        } else if (AppCompatDelegate.getDefaultNightMode() != appCompatMode(choice)) {
            AppCompatDelegate.setDefaultNightMode(appCompatMode(choice))
        }
        return choice
    }

    /** Override configuration for a non-AppCompat screen on API 26-30; null when nothing to override. */
    fun overrideConfiguration(choice: ThemeChoice): Configuration? {
        if (usesSystemApi || choice == ThemeChoice.SYSTEM) return null
        return Configuration().apply {
            // A delta: fontScale 0 and UNDEFINED fields leave everything else as the system has it.
            fontScale = 0f
            uiMode = if (choice == ThemeChoice.DARK) Configuration.UI_MODE_NIGHT_YES else Configuration.UI_MODE_NIGHT_NO
        }
    }

    /** True when a Compose screen built with [applied] is out of date (API 26-30 only). */
    fun isStale(context: Context, applied: ThemeChoice?): Boolean =
        !usesSystemApi && applied != null && applied != Storage.getThemeChoice(context)

    private fun isNight(config: Configuration) =
        config.uiMode and Configuration.UI_MODE_NIGHT_MASK == Configuration.UI_MODE_NIGHT_YES

    private fun appCompatMode(choice: ThemeChoice) = when (choice) {
        ThemeChoice.SYSTEM -> AppCompatDelegate.MODE_NIGHT_FOLLOW_SYSTEM
        ThemeChoice.LIGHT -> AppCompatDelegate.MODE_NIGHT_NO
        ThemeChoice.DARK -> AppCompatDelegate.MODE_NIGHT_YES
    }

    private fun setSystemNightMode(context: Context, choice: ThemeChoice) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return
        val manager = context.getSystemService(UiModeManager::class.java) ?: return
        manager.setApplicationNightMode(
            when (choice) {
                // AUTO clears the app override: the app follows the phone again.
                ThemeChoice.SYSTEM -> UiModeManager.MODE_NIGHT_AUTO
                ThemeChoice.LIGHT -> UiModeManager.MODE_NIGHT_NO
                ThemeChoice.DARK -> UiModeManager.MODE_NIGHT_YES
            }
        )
    }
}

/** Base for the Compose screens: applies the in-app theme (see [AppTheme]). */
abstract class ThemedComponentActivity : ComponentActivity() {
    private var appliedTheme: ThemeChoice? = null

    override fun attachBaseContext(newBase: Context) {
        val choice = AppTheme.prepare(newBase)
        appliedTheme = choice
        super.attachBaseContext(newBase)
        AppTheme.overrideConfiguration(choice)?.let { applyOverrideConfiguration(it) }
    }

    override fun onRestart() {
        super.onRestart()
        if (AppTheme.isStale(this, appliedTheme)) recreate()
    }
}

/** Base for the AppCompat screens: sets the AppCompat night mode before AppCompat reads it. */
abstract class ThemedAppCompatActivity : AppCompatActivity() {
    override fun attachBaseContext(newBase: Context) {
        AppTheme.prepare(newBase)
        super.attachBaseContext(newBase)
    }
}

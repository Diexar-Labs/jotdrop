package com.diexar.keepcapture.baselineprofile

import android.os.ParcelFileDescriptor
import androidx.benchmark.macro.MacrobenchmarkScope
import androidx.benchmark.macro.junit4.BaselineProfileRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.Direction
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.util.regex.Pattern

private const val PACKAGE = "com.diexar.keepcapture"
private const val VAULT_DIR = "JotDropBaseline"
private const val TIMEOUT_MS = 15_000L

// First card in the seeded vault (pinned, so it is always at the top).
private const val FIRST_CARD = "Checklist 001"

/**
 * Records the startup + notes-list scroll journey into a Baseline Profile.
 *
 * Run with `./gradlew :app:generateBaselineProfile` (see baselineprofile/build.gradle.kts).
 * Needs a device on API 33+ (or a rooted API 28+ device) and API 31+ for seeding.
 */
@RunWith(AndroidJUnit4::class)
class BaselineProfileGenerator {

    @get:Rule
    val rule = BaselineProfileRule()

    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val device = UiDevice.getInstance(instrumentation)

    /**
     * Seeds the test vault and picks it once through the system folder picker.
     * Runs before [BaselineProfileRule.collect], which resets the app's compiled
     * state and profiles, so this setup does not end up in the profile.
     */
    @Before
    fun seedVaultAndPickFolder() {
        val seed = instrumentation.context.assets.open("seed-notes.sh").use { it.readBytes() }
        runShellWithStdin("sh", seed)

        device.pressHome()
        launchApp()
        // Fresh install: empty state with "Open settings" -> settings -> folder picker.
        val openSettings = device.wait(Until.findObject(By.text(ignoreCase("Open settings"))), TIMEOUT_MS)
            ?: return // vault already chosen (app data kept from an earlier run)
        openSettings.click()
        device.wait(Until.findObject(By.res(PACKAGE, "pickVaultButton")), TIMEOUT_MS)!!.click()

        // DocumentsUI (OPEN_DOCUMENT_TREE) opens at the storage root.
        device.wait(Until.findObject(By.text("Documents")), TIMEOUT_MS)!!.click()
        device.wait(Until.findObject(By.text(VAULT_DIR)), TIMEOUT_MS)!!.click()
        device.wait(Until.hasObject(By.text(ignoreCase("Mini Notes"))), TIMEOUT_MS)
        device.wait(Until.findObject(By.text(ignoreCase("Use this folder"))), TIMEOUT_MS)!!.click()
        device.wait(Until.findObject(By.text(ignoreCase("Allow"))), TIMEOUT_MS)!!.click()
        device.wait(Until.hasObject(By.res(PACKAGE, "pickVaultButton")), TIMEOUT_MS)
        device.pressBack()
        check(device.wait(Until.hasObject(By.text(FIRST_CARD)), TIMEOUT_MS)) {
            "Seeded notes did not appear in the notes list"
        }
    }

    @Test
    fun startupAndScrollNotes() = rule.collect(
        packageName = PACKAGE,
        includeInStartupProfile = true,
    ) {
        killProcess()
        pressHome()
        startActivityAndWait()
        scrollNotesGrid()
    }

    private fun MacrobenchmarkScope.scrollNotesGrid() {
        check(device.wait(Until.hasObject(By.text(FIRST_CARD)), TIMEOUT_MS)) { "Notes list not shown" }
        // The tag-chip row is scrollable too; the notes grid is the tallest one.
        val grid = device.findObjects(By.pkg(PACKAGE).scrollable(true))
            .maxByOrNull { it.visibleBounds.height() }
            ?: error("No scrollable notes grid found")
        // Leave room at the edges so the gesture is a fling, not a system edge swipe.
        grid.setGestureMargin(device.displayWidth / 5)
        repeat(6) {
            grid.fling(Direction.DOWN)
            device.waitForIdle()
        }
        repeat(6) {
            grid.fling(Direction.UP)
            device.waitForIdle()
        }
        // Slower drags render cards frame by frame, like a thumb reading the list.
        repeat(4) {
            grid.scroll(Direction.DOWN, 0.8f, 1500)
        }
        device.waitForIdle()
    }

    private fun launchApp() {
        val intent = instrumentation.context.packageManager.getLaunchIntentForPackage(PACKAGE)
            ?: error("$PACKAGE is not installed")
        intent.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK or android.content.Intent.FLAG_ACTIVITY_CLEAR_TASK)
        instrumentation.context.startActivity(intent)
        device.wait(Until.hasObject(By.pkg(PACKAGE).depth(0)), TIMEOUT_MS)
    }

    /** Runs [command] as the shell user with [stdin] piped in (API 31+). */
    private fun runShellWithStdin(command: String, stdin: ByteArray) {
        val (stdout, input) = instrumentation.uiAutomation.executeShellCommandRw(command)
        ParcelFileDescriptor.AutoCloseOutputStream(input).use { it.write(stdin) }
        val output = ParcelFileDescriptor.AutoCloseInputStream(stdout).use { it.readBytes().decodeToString() }
        check("seeded 90 notes" in output) { "Seeding failed: $output" }
    }

    private fun ignoreCase(text: String): Pattern =
        Pattern.compile(Pattern.quote(text), Pattern.CASE_INSENSITIVE)
}

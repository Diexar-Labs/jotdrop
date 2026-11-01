package com.diexar.keepcapture

import android.content.Context
import android.net.Uri
import android.provider.DocumentsContract
import androidx.documentfile.provider.DocumentFile
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.concurrent.TimeUnit
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream

/**
 * JotDrop Plus: a ZIP of the notes folder every week, in a folder of your choice. Android's folder picker also offers
 * apps such as Drive or Dropbox when they support it, so no account of theirs comes through us. The ZIP is plain files:
 * being able to read them without JotDrop is the point.
 */
object CloudBackup {
    private const val WEEKLY = "jotdrop-backup-weekly"
    private const val KEEP = 4
    private const val PREFIX = "JotDrop backup "
    private fun prefs(context: Context) = context.getSharedPreferences("backup", Context.MODE_PRIVATE)

    fun folder(context: Context): Uri? = prefs(context).getString("folder", null)?.let(Uri::parse)
    fun lastMessage(context: Context): String = prefs(context).getString("message", "").orEmpty()
    private fun say(context: Context, message: String) = prefs(context).edit().putString("message", message).apply()

    /** The folder may not be inside the notes folder: every backup would hold the ones before it. */
    fun insideNotes(vault: Uri, target: Uri): Boolean {
        val notes = DocumentsContract.getTreeDocumentId(vault)
        val chosen = DocumentsContract.getTreeDocumentId(target)
        return chosen == notes || chosen.startsWith("${notes.trimEnd('/')}/")
    }

    fun setFolder(context: Context, uri: Uri?) {
        val work = WorkManager.getInstance(context)
        if (uri == null) {
            prefs(context).edit().remove("folder").apply()
            work.cancelUniqueWork(WEEKLY)
            return
        }
        Storage.persistUriPermission(context, uri)
        prefs(context).edit().putString("folder", uri.toString()).apply()
        work.enqueueUniquePeriodicWork(WEEKLY, ExistingPeriodicWorkPolicy.UPDATE,
            PeriodicWorkRequestBuilder<CloudBackupWorker>(7, TimeUnit.DAYS)
                .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).setRequiresBatteryNotLow(true).build())
                .build())
    }

    fun hasPlus(context: Context): Boolean {
        val credentials = CloudPreviewStore(context).credentials() ?: return false
        return CloudClient(credentials).call("/status").optJSONObject("plan")?.optString("name") == "plus"
    }

    /** Throws when it did not work, and leaves the reason for the screen: nobody watches the weekly run. */
    fun run(context: Context): String = try {
        write(context).also { say(context, it) }
    } catch (error: Exception) {
        say(context, "The last backup failed: ${error.message ?: error.javaClass.simpleName}")
        throw error
    }

    /** A half-written ZIP never keeps the name of a finished one. */
    private fun write(context: Context): String {
        val vault = requireNotNull(Storage.getVaultUri(context)) { "Choose a notes folder first." }
        val target = requireNotNull(folder(context)) { "Choose a backup folder first." }
        require(!insideNotes(vault, target)) { "Choose a backup folder outside your notes folder." }
        val destination = requireNotNull(DocumentFile.fromTreeUri(context, target)?.takeIf { it.canWrite() }) { "JotDrop cannot write to that folder any more. Choose it again." }
        val source = requireNotNull(DocumentFile.fromTreeUri(context, vault)) { "The notes folder cannot be opened." }
        val name = PREFIX + SimpleDateFormat("yyyy-MM-dd HHmm", Locale.ROOT).format(Date())
        val part = requireNotNull(destination.createFile("application/octet-stream", "$name.part")) { "JotDrop cannot write to that folder any more. Choose it again." }
        var files = 0
        try {
            requireNotNull(context.contentResolver.openOutputStream(part.uri)) { "JotDrop cannot write to that folder any more. Choose it again." }.use { raw ->
                ZipOutputStream(raw.buffered()).use { zip ->
                    fun add(dir: DocumentFile, path: String) {
                        for (child in dir.listFiles()) {
                            val childName = child.name ?: continue
                            // Copies kept for recovery and half-finished work are not notes.
                            if (childName.startsWith(".cloud") || childName.endsWith(".part")) continue
                            if (child.isDirectory) add(child, "$path$childName/")
                            else context.contentResolver.openInputStream(child.uri)?.use { input ->
                                zip.putNextEntry(ZipEntry("$path$childName").apply { time = child.lastModified() })
                                input.copyTo(zip)
                                zip.closeEntry()
                                files++
                            }
                        }
                    }
                    add(source, "")
                }
            }
            check(part.renameTo("$name.zip")) { "The backup could not be finished." }
        } catch (error: Exception) {
            runCatching { part.delete() }
            throw error
        }
        // Oldest first; only what this feature made, never anything else in that folder.
        destination.listFiles().filter { it.name?.startsWith(PREFIX) == true && it.name?.endsWith(".zip") == true }
            .sortedByDescending { it.name }.drop(KEEP).forEach { runCatching { it.delete() } }
        // Asked from the file: a second backup within a minute gets a number from Android.
        return "Last backup: ${part.name ?: "$name.zip"}, $files files."
    }

    fun skipped(context: Context) = say(context, "Backups stopped because JotDrop Plus ended. Your earlier backups stay in the folder.")
}

class CloudBackupWorker(context: Context, parameters: WorkerParameters) : CoroutineWorker(context, parameters) {
    override suspend fun doWork(): Result = withContext(Dispatchers.IO) {
        try {
            if (!CloudBackup.hasPlus(applicationContext)) { CloudBackup.skipped(applicationContext); return@withContext Result.success() }
            CloudBackup.run(applicationContext)
            Result.success()
        } catch (_: Exception) {
            if (runAttemptCount < 3) Result.retry() else Result.failure()
        }
    }
}

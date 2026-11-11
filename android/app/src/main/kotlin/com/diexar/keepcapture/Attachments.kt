package com.diexar.keepcapture

import android.content.ContentResolver
import android.content.Context
import android.net.Uri
import android.widget.Toast
import java.util.Locale

/**
 * Attach file (editor, card menu) and Share to JotDrop for every file: one way to bring files into a note, the same
 * as the Obsidian plugin's saveAttachedFiles. A file over the plan's maximum is refused at once with a clear message
 * instead of staying behind on this phone at the next sync. Plus is named in words only (Play payments policy).
 */
object Attachments {
    /**
     * What happened to the files: the names they got here, the names their app gave them ([shown], in the same
     * order, for a note's title), and the messages for files that were refused or failed.
     */
    data class Outcome(val names: List<String>, val problems: List<String>, val shown: List<String> = emptyList())

    /**
     * Copies [sources] into the attachments folder of the group [spaceId] (or the own one). Runs on a background
     * thread. [limit] is the plan's maximum per file ([CloudSyncManager.attachLimit]); null means no check.
     */
    fun copy(context: Context, sources: List<Uri>, spaceId: String?, limit: Long? = CloudSyncManager.attachLimit(context)): Outcome {
        val names = mutableListOf<String>()
        val shownNames = mutableListOf<String>()
        val problems = mutableListOf<String>()
        for (source in sources.distinct()) {
            val shown = Storage.displayName(context, source) ?: source.lastPathSegment ?: "?"
            if (!isReadableSource(context, source)) {
                problems += context.getString(R.string.attach_failed, shown, context.getString(R.string.attach_unreadable))
                continue
            }
            val size = Storage.fileSize(context, source)
            if (limit != null && size > limit) {
                problems += tooLarge(context, shown, limit)
                continue
            }
            Storage.copyFileToAttachments(context, source, spaceId, name = shown).fold(
                { names += it; shownNames += shown },
                { problems += context.getString(R.string.attach_failed, shown, it.message ?: it.javaClass.simpleName) },
            )
        }
        return Outcome(names, problems, shownNames)
    }

    /**
     * Only files another app hands over (content://), never one of JotDrop's own private files: an app could
     * otherwise share `file:///data/data/...` or our FileProvider and have JotDrop copy its private data into the vault.
     */
    fun isReadableSource(context: Context, uri: Uri): Boolean {
        if (uri.scheme != ContentResolver.SCHEME_CONTENT) return false
        val authority = uri.authority.orEmpty()
        return authority.isNotEmpty() && authority != context.packageName && !authority.startsWith("${context.packageName}.")
    }

    /** "is larger than 25 MB, your plan's maximum per file", with the Plus line while the plan is not the largest one. */
    fun tooLarge(context: Context, name: String, limit: Long): String {
        val message = context.getString(R.string.attach_too_large, name, "${(limit + 524288) / 1048576} MB")
        return if (limit < CloudCrypto.MAX_CHUNKED_BYTES) "$message ${context.getString(R.string.attach_plus)}" else message
    }

    /** Like the web app's and the plugin's file chips: "840 KiB", "12.4 MiB". */
    fun formatSize(bytes: Long): String =
        if (bytes >= 1048576) String.format(Locale.US, "%.1f MiB", bytes / 1048576.0) else "${maxOf(1L, (bytes + 1023) / 1024)} KiB"

    /** "Attached Offerte.pdf." or "Attached 3 files.", once the files are in. */
    fun toastAttached(context: Context, names: List<String>) {
        if (names.isEmpty()) return
        val text = if (names.size == 1) context.getString(R.string.attach_done_one, names[0])
            else context.getString(R.string.attach_done_many, names.size)
        Toast.makeText(context, text, Toast.LENGTH_SHORT).show()
    }
}

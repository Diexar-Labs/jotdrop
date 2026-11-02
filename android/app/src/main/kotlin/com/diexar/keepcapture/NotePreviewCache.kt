package com.diexar.keepcapture

import android.content.Context
import android.net.Uri
import android.util.AtomicFile
import org.json.JSONObject
import java.io.File

/**
 * Remembers the start of every note with its modified time and size, so opening the app
 * does not reopen every file (Eric, 2 Nov: a slow start with 49 notes took 2.5 s).
 * A note is only reused when both its modified time and its size are unchanged; anything
 * else, or a provider that reports neither, reads the file as before.
 */
internal object NotePreviewCache {
    private const val MAX_ENTRY_CHARS = 64 * 1024
    private const val MAX_ENTRIES = 5000
    private class Entry(val modified: Long, val size: Long, val preview: String)
    private val entries = HashMap<String, Entry>()
    private var loaded = false
    private var dirty = false

    private fun file(context: Context) = AtomicFile(File(context.noBackupFilesDir, "note-previews.json"))

    private fun load(context: Context) {
        if (loaded) return
        loaded = true
        try {
            val json = JSONObject(file(context).readFully().toString(Charsets.UTF_8))
            if (json.optInt("version") != 1) return
            val items = json.getJSONObject("notes")
            for (key in items.keys()) {
                val item = items.getJSONObject(key)
                entries[key] = Entry(item.getLong("m"), item.getLong("s"), item.getString("p"))
            }
        } catch (_: Exception) {
            entries.clear()
        }
    }

    @Synchronized
    fun get(context: Context, uri: Uri, modified: Long, size: Long): String? {
        if (modified <= 0L || size < 0L) return null
        load(context)
        val entry = entries[uri.toString()] ?: return null
        return entry.preview.takeIf { entry.modified == modified && entry.size == size }
    }

    @Synchronized
    fun put(context: Context, uri: Uri, modified: Long, size: Long, preview: String) {
        load(context)
        val key = uri.toString()
        if (modified <= 0L || size < 0L || preview.length > MAX_ENTRY_CHARS) {
            if (entries.remove(key) != null) dirty = true
            return
        }
        if (entries.size >= MAX_ENTRIES && key !in entries) entries.clear()
        entries[key] = Entry(modified, size, preview)
        dirty = true
    }

    @Synchronized
    fun save(context: Context) {
        if (!dirty) return
        val notes = JSONObject()
        for ((key, entry) in entries) notes.put(key, JSONObject().put("m", entry.modified).put("s", entry.size).put("p", entry.preview))
        val target = file(context)
        val out = target.startWrite()
        try {
            out.write(JSONObject().put("version", 1).put("notes", notes).toString().toByteArray(Charsets.UTF_8))
            target.finishWrite(out)
            dirty = false
        } catch (e: Exception) {
            target.failWrite(out)
        }
    }
}

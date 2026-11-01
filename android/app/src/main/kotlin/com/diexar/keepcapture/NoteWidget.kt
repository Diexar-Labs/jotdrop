package com.diexar.keepcapture

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.graphics.Paint
import android.net.Uri
import android.os.Bundle
import android.view.View
import android.widget.RemoteViews
import android.widget.RemoteViewsService
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.documentfile.provider.DocumentFile
import com.diexar.keepcapture.ui.JotDropTheme
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext

/** Keeps the widgets on the home screen in step with the notes. */
object HomeWidgets {
    fun refresh(context: Context) {
        QuickCaptureWidget.refresh(context)
        NoteWidget.refresh(context)
    }
}

/** What a note looks like on a widget: its title and rows, where a checklist row knows its place in the note. */
object NoteWidgetContent {
    data class Row(val text: String, val checklistIndex: Int?, val checked: Boolean)
    data class Content(val title: String?, val rows: List<Row>)

    private const val MAX_ROWS = 100
    private val item = Regex("^\\s*-\\s+\\[([ xX])\\](?:\\s+(.*))?$")
    private val heading = Regex("^#{1,6}\\s+(.*)$")
    private val attachment = Regex("^!\\[\\[.*\\]\\]$|^!\\[.*\\]\\(.*\\)$")

    fun parse(note: String): Content {
        val lines = FrontmatterParser.parse(note).body.split(Regex("\\r?\\n"))
        var title: String? = null
        var index = 0
        var first = true
        val rows = mutableListOf<Row>()
        for (line in lines) {
            val match = item.find(line)
            if (match != null) {
                val text = match.groupValues[2].trim()
                if (rows.size < MAX_ROWS) rows += Row(text, index, match.groupValues[1] != " ")
                index++
                first = false
                continue
            }
            val trimmed = line.trim()
            if (trimmed.isEmpty() || attachment.matches(trimmed)) continue
            val title1 = heading.find(trimmed)?.groupValues?.get(1)?.trim()
            if (first && title1 != null) title = title1
            else if (rows.size < MAX_ROWS) rows += Row(title1 ?: trimmed, null, false)
            first = false
        }
        return Content(title, rows)
    }
}

/** One note per copy, so people can place as many as they have lists. The text only shows because someone chose this note. */
class NoteWidget : AppWidgetProvider() {
    override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) {
        val pending = goAsync()
        CoroutineScope(Dispatchers.IO).launch {
            try { ids.forEach { render(context, manager, it) } } finally { pending.finish() }
        }
    }

    override fun onDeleted(context: Context, ids: IntArray) {
        val edit = prefs(context).edit()
        ids.forEach { edit.remove(key(it)) }
        edit.apply()
    }

    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != ACTION_TOGGLE) return super.onReceive(context, intent)
        val id = intent.getIntExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, AppWidgetManager.INVALID_APPWIDGET_ID)
        val index = intent.getIntExtra(EXTRA_ROW_INDEX, -1)
        val text = intent.getStringExtra(EXTRA_ROW_TEXT)
        val uri = noteUri(context, id)
        if (uri == null || index < 0) return
        val pending = goAsync()
        CoroutineScope(Dispatchers.IO).launch {
            try {
                val result = Storage.noteWriteMutex.withLock {
                    // A sync may have changed the note since this row was drawn: never tick a different line.
                    val current = Storage.readNote(context, uri).getOrElse { return@withLock Result.failure(it) }
                    val row = NoteWidgetContent.parse(current).rows.firstOrNull { it.checklistIndex == index }
                    if (row == null || row.text != text) Result.success(Unit) else Storage.toggleChecklistItem(context, uri, index)
                }
                result.onFailure { withContext(Dispatchers.Main) { Toast.makeText(context, it.message ?: context.getString(R.string.error_generic), Toast.LENGTH_SHORT).show() } }
                CloudSyncManager.notifyNotesChanged()
                refresh(context)
            } finally { pending.finish() }
        }
    }

    companion object {
        const val ACTION_TOGGLE = "com.diexar.keepcapture.action.WIDGET_TOGGLE"
        const val EXTRA_ROW_INDEX = "row_index"
        const val EXTRA_ROW_TEXT = "row_text"

        private fun prefs(context: Context) = context.getSharedPreferences("note_widgets", Context.MODE_PRIVATE)
        private fun key(id: Int) = "note_$id"

        fun noteUri(context: Context, id: Int): Uri? = prefs(context).getString(key(id), null)?.let(Uri::parse)

        fun choose(context: Context, id: Int, uri: Uri) {
            prefs(context).edit().putString(key(id), uri.toString()).apply()
            val manager = AppWidgetManager.getInstance(context)
            render(context, manager, id)
            manager.notifyAppWidgetViewDataChanged(id, R.id.widget_note_items)
        }

        fun refresh(context: Context) {
            val manager = AppWidgetManager.getInstance(context)
            val ids = manager.getAppWidgetIds(ComponentName(context, NoteWidget::class.java))
            if (ids.isEmpty()) return
            CoroutineScope(Dispatchers.IO).launch {
                ids.forEach { render(context, manager, it) }
                manager.notifyAppWidgetViewDataChanged(ids, R.id.widget_note_items)
            }
        }

        private fun render(context: Context, manager: AppWidgetManager, id: Int) {
            val views = RemoteViews(context.packageName, R.layout.widget_note)
            val uri = noteUri(context, id)
            val note = uri?.let { Storage.readNote(context, it).getOrNull() }
            val configure = PendingIntent.getActivity(
                context, id,
                Intent(context, NoteWidgetConfigureActivity::class.java)
                    .setAction(AppWidgetManager.ACTION_APPWIDGET_CONFIGURE)
                    .putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, id)
                    .setData(Uri.parse("jotdrop-widget://configure/$id"))
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
            )
            if (uri == null || note == null) {
                views.setTextViewText(R.id.widget_note_title, context.getString(R.string.widget_note_gone))
                views.setOnClickPendingIntent(R.id.widget_note_title, configure)
                views.setViewVisibility(R.id.widget_note_items, View.GONE)
                views.setViewVisibility(R.id.widget_note_empty, View.GONE)
                manager.updateAppWidget(id, views)
                return
            }
            val title = NoteWidgetContent.parse(note).title
                ?: DocumentFile.fromSingleUri(context, uri)?.name?.removeSuffix(".md")
                ?: context.getString(R.string.widget_note_name)
            views.setTextViewText(R.id.widget_note_title, title)
            views.setOnClickPendingIntent(
                R.id.widget_note_title,
                PendingIntent.getActivity(
                    context, id,
                    EditorActivity.openNoteIntent(context, uri).setData(Uri.parse("jotdrop-widget://note/$id")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                    PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
                ),
            )
            // Each copy needs its own data, or the system hands every copy the rows of the first.
            views.setRemoteAdapter(R.id.widget_note_items, Intent(context, NoteWidgetService::class.java).putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, id).setData(Uri.parse("jotdrop-widget://rows/$id")))
            views.setEmptyView(R.id.widget_note_items, R.id.widget_note_empty)
            views.setPendingIntentTemplate(
                R.id.widget_note_items,
                PendingIntent.getBroadcast(
                    context, id,
                    Intent(context, NoteWidget::class.java).setAction(ACTION_TOGGLE).putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, id).setData(Uri.parse("jotdrop-widget://toggle/$id")),
                    PendingIntent.FLAG_MUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
                ),
            )
            manager.updateAppWidget(id, views)
        }
    }
}

class NoteWidgetService : RemoteViewsService() {
    override fun onGetViewFactory(intent: Intent): RemoteViewsFactory =
        NoteWidgetRows(applicationContext, intent.getIntExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, AppWidgetManager.INVALID_APPWIDGET_ID))
}

private class NoteWidgetRows(private val context: Context, private val id: Int) : RemoteViewsService.RemoteViewsFactory {
    private var rows = emptyList<NoteWidgetContent.Row>()

    override fun onDataSetChanged() {
        rows = NoteWidget.noteUri(context, id)?.let { Storage.readNote(context, it).getOrNull() }?.let { NoteWidgetContent.parse(it).rows }.orEmpty()
    }

    override fun getViewAt(position: Int): RemoteViews {
        val views = RemoteViews(context.packageName, R.layout.widget_note_item)
        val row = rows.getOrNull(position) ?: return views
        views.setTextViewText(R.id.widget_note_item_text, row.text)
        val strike = if (row.checked) Paint.STRIKE_THRU_TEXT_FLAG else 0
        views.setInt(R.id.widget_note_item_text, "setPaintFlags", strike or Paint.ANTI_ALIAS_FLAG)
        if (row.checklistIndex == null) {
            views.setViewVisibility(R.id.widget_note_item_box, View.GONE)
        } else {
            views.setViewVisibility(R.id.widget_note_item_box, View.VISIBLE)
            views.setImageViewResource(R.id.widget_note_item_box, if (row.checked) R.drawable.ic_widget_box_checked else R.drawable.ic_widget_box)
            views.setOnClickFillInIntent(
                R.id.widget_note_item,
                Intent().putExtra(NoteWidget.EXTRA_ROW_INDEX, row.checklistIndex).putExtra(NoteWidget.EXTRA_ROW_TEXT, row.text),
            )
        }
        return views
    }

    override fun getCount() = rows.size
    override fun getLoadingView(): RemoteViews? = null
    override fun getViewTypeCount() = 1
    override fun getItemId(position: Int) = position.toLong()
    override fun hasStableIds() = false
    override fun onCreate() = Unit
    override fun onDestroy() = Unit
}

/** Placing a note widget asks which note it shows. */
class NoteWidgetConfigureActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setResult(RESULT_CANCELED)
        val id = intent.getIntExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, AppWidgetManager.INVALID_APPWIDGET_ID)
        val info = AppWidgetManager.getInstance(this).getAppWidgetInfo(id)
        if (info == null || info.provider != ComponentName(this, NoteWidget::class.java)) return finish()
        setContent {
            JotDropTheme {
                var notes by remember { mutableStateOf<List<NoteSummary>?>(null) }
                LaunchedEffect(Unit) {
                    notes = withContext(Dispatchers.IO) {
                        if (Storage.getVaultUri(this@NoteWidgetConfigureActivity) == null) emptyList()
                        else Storage.listNotes(this@NoteWidgetConfigureActivity).getOrDefault(emptyList()).sortedByDescending { it.lastModified }
                    }
                }
                Scaffold { padding ->
                    Column(Modifier.fillMaxSize().padding(padding).padding(16.dp)) {
                        Text(stringResource(R.string.widget_note_pick), style = MaterialTheme.typography.headlineSmall, modifier = Modifier.padding(bottom = 12.dp))
                        val shown = notes
                        when {
                            shown == null -> CircularProgressIndicator()
                            shown.isEmpty() -> Text(stringResource(R.string.widget_note_none))
                            else -> LazyColumn {
                                items(shown, key = { it.uri.toString() }) { note ->
                                    Column(
                                        Modifier.fillMaxWidth().clickable {
                                            NoteWidget.choose(this@NoteWidgetConfigureActivity, id, note.uri)
                                            setResult(RESULT_OK, Intent().putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, id))
                                            finish()
                                        }.padding(vertical = 12.dp),
                                    ) {
                                        Text(note.title.ifBlank { note.filename.removeSuffix(".md") }, style = MaterialTheme.typography.titleMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                        if (note.snippet.isNotBlank()) Text(note.snippet.replace(Regex("(?m)^\\s*-\\s+\\[([ xX])\\]\\s*")) { if (it.groupValues[1] == " ") "☐ " else "☑ " }, style = MaterialTheme.typography.bodySmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

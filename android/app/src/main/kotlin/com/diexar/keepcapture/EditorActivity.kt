package com.diexar.keepcapture

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.media.MediaPlayer
import android.net.Uri
import android.os.Bundle
import android.speech.RecognizerIntent
import android.widget.Toast
import androidx.activity.compose.BackHandler
import androidx.activity.enableEdgeToEdge
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.FileProvider
import java.io.File
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Calendar
import java.util.Locale
import java.util.TimeZone
import kotlinx.coroutines.sync.withLock
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.wrapContentSize
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsFocusedAsState
import androidx.compose.foundation.relocation.BringIntoViewRequester
import androidx.compose.foundation.relocation.bringIntoViewRequester
import androidx.compose.material3.LocalTextStyle
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.unit.sp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.IntOffset
import androidx.compose.foundation.text.ClickableText
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.material.icons.Icons
import coil.compose.AsyncImage
import androidx.compose.ui.layout.ContentScale
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.isAltPressed
import androidx.compose.ui.input.key.isCtrlPressed
import androidx.compose.ui.input.key.isMetaPressed
import androidx.compose.ui.input.key.isShiftPressed
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.layout.boundsInRoot
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.platform.LocalAccessibilityManager
import androidx.compose.ui.platform.LocalView
import androidx.compose.material.icons.filled.CheckBoxOutlineBlank
import androidx.compose.material.icons.filled.DeleteSweep
import androidx.compose.material.icons.filled.VerticalAlignBottom
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.layout.positionInWindow
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowLeft
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.AddAPhoto
import androidx.compose.material.icons.filled.Draw
import androidx.compose.material.icons.filled.Archive
import androidx.compose.material.icons.filled.AttachFile
import androidx.compose.material.icons.filled.AutoAwesome
import androidx.compose.material.icons.filled.CameraAlt
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.CheckBox
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.DriveFileMove
import androidx.compose.material.icons.filled.Image
import androidx.compose.material.icons.filled.Link
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.Info
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.Label
import androidx.compose.material.icons.filled.Notifications
import androidx.compose.material.icons.filled.Palette
import androidx.compose.material.icons.filled.Pause
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.TextFields
import androidx.compose.material.icons.filled.PushPin
import androidx.compose.material3.AlertDialog
import androidx.compose.runtime.produceState
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DatePicker
import androidx.compose.material3.DatePickerDialog
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.TimeInput
import androidx.compose.material3.rememberDatePickerState
import androidx.compose.material3.rememberTimePickerState
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.LocalMinimumInteractiveComponentEnforcement
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.withFrameNanos
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.saveable.listSaver
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshots.SnapshotStateList
import androidx.compose.runtime.toMutableStateList
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalDensity
import com.diexar.keepcapture.ui.JotDropTheme
import com.diexar.keepcapture.ui.noteCardBrush
import com.diexar.keepcapture.ui.screenBackgroundBrush
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

class EditorActivity : ThemedComponentActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        val noteUri: Uri? = intent.getStringExtra(EXTRA_NOTE_URI)?.let(Uri::parse)
        val navUris: List<String> = intent.getStringArrayListExtra(EXTRA_NAV_URIS) ?: emptyList()
        val thumbnail = intent.getStringExtra(EXTRA_THUMBNAIL_NAME)?.let { name ->
            intent.getStringExtra(EXTRA_THUMBNAIL_URI)?.let { name to Uri.parse(it) }
        }

        setContent {
            JotDropTheme {
                EditorScreen(
                    initialUri = noteUri,
                    navUris = navUris,
                    initialThumbnail = thumbnail,
                    initialLabel = intent.getStringExtra(EXTRA_INITIAL_LABEL)?.takeIf { noteUri == null && LabelNames.validate(it) },
                    onClose = { finish() },
                )
            }
        }
    }

    companion object {
        private const val EXTRA_NOTE_URI = "note_uri"
        private const val EXTRA_NAV_URIS = "nav_uris"
        private const val EXTRA_THUMBNAIL_NAME = "thumbnail_name"
        private const val EXTRA_THUMBNAIL_URI = "thumbnail_uri"
        private const val EXTRA_INITIAL_LABEL = "initial_label"

        // Intent-extra's lopen via de Binder (limiet ~500KB) en SAF-URI's zijn lang.
        // Beperk de nav-lijst daarom tot een venster rond de geopende notitie.
        private const val NAV_WINDOW = 150

        fun newNoteIntent(context: Context, label: String? = null): Intent =
            Intent(context, EditorActivity::class.java).putExtra(EXTRA_INITIAL_LABEL, label)

        /**
         * Opent een notitie in de editor. [orderedUris] is optioneel de zichtbare
         * kaartvolgorde (gepind eerst, dan de rest, met actieve filters) — daarmee
         * kan de editor met de knoppen boven de notitie naar de vorige/volgende notitie.
         */
        fun openNoteIntent(
            context: Context,
            uri: Uri,
            orderedUris: List<Uri> = emptyList(),
            thumbnailName: String? = null,
            thumbnailUri: Uri? = null,
        ): Intent {
            val intent = Intent(context, EditorActivity::class.java).putExtra(EXTRA_NOTE_URI, uri.toString())
            if (thumbnailName != null && thumbnailUri != null) {
                intent.putExtra(EXTRA_THUMBNAIL_NAME, thumbnailName)
                intent.putExtra(EXTRA_THUMBNAIL_URI, thumbnailUri.toString())
            }
            val idx = orderedUris.indexOf(uri)
            if (orderedUris.size >= 2 && idx >= 0) {
                val from = (idx - NAV_WINDOW).coerceAtLeast(0)
                val to = (idx + NAV_WINDOW + 1).coerceAtMost(orderedUris.size)
                intent.putStringArrayListExtra(
                    EXTRA_NAV_URIS,
                    ArrayList(orderedUris.subList(from, to).map { it.toString() }),
                )
            }
            return intent
        }
    }
}

// Saver voor mutableStateListOf<String> in rememberSaveable (rotatie/procesdood).
private val stringStateListSaver = listSaver<SnapshotStateList<String>, String>(
    save = { it.toList() },
    restore = { it.toMutableStateList() },
)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun EditorScreen(
    initialUri: Uri?,
    navUris: List<String>,
    initialThumbnail: Pair<String, Uri>?,
    initialLabel: String?,
    onClose: () -> Unit,
) {
    val context = LocalContext.current
    val view = LocalView.current
    val scope = rememberCoroutineScope()
    val dark = isSystemInDarkTheme()

    // Alle inhouds-state is rememberSaveable: bij rotatie of procesdood
    // (camera/foto-picker opent een andere app!) recreëert de activity en
    // gooide `remember` alle ongetypte tekst weg. `loaded` is ook saveable,
    // anders herlaadt de LaunchedEffect de notitie van schijf óver de
    // herstelde (ongesavede) tekst heen.
    var currentUri by rememberSaveable { mutableStateOf(initialUri?.toString()) }
    var loadedBodyHash by rememberSaveable { mutableStateOf<String?>(null) }
    // Echt conflict bij opslaan: de versie die nu in het bestand staat, plus de
    // opslagactie die na "Mijn versie gebruiken" opnieuw moet lopen.
    var saveConflict by remember { mutableStateOf<Pair<String, () -> Unit>?>(null) }
    DisposableEffect(currentUri) {
        val uri = currentUri?.let(Uri::parse)
        if (uri != null) CloudSyncManager.openEditor(uri)
        onDispose { if (uri != null) CloudSyncManager.closeEditor(uri) }
    }
    // Positie binnen de meegegeven kaartvolgorde; -1 = geen navigatie mogelijk.
    var navIndex by rememberSaveable { mutableStateOf(navUris.indexOf(initialUri?.toString())) }
    val navEnabled = navUris.size >= 2 && navIndex >= 0
    var loaded by rememberSaveable { mutableStateOf(initialUri == null) }
    // Saveable zoals `loaded`: anders toonde een draai een lege editor voor een niet-geladen notitie.
    var loadError by rememberSaveable { mutableStateOf<String?>(null) }
    // Notitie met een geparkeerde, niet af te maken opslag: de editor biedt dan de uitweg.
    var parkedUri by rememberSaveable { mutableStateOf<String?>(null) }
    var parkedBusy by remember { mutableStateOf(false) }
    var showParkedDiscard by rememberSaveable { mutableStateOf(false) }
    var bodyText by rememberSaveable(stateSaver = TextFieldValue.Saver) {
        mutableStateOf(TextFieldValue(""))
    }
    val staleBody = remember { StaleField() }
    // The Markdown switch (design opmaak-editor 5.1): off shows the formatting, on the raw text; kept per device.
    var markdownMode by remember { mutableStateOf(EditorPrefs.markdown(context)) }
    var bodyFocused by remember { mutableStateOf(false) }
    // Tables in the formatted view (design 7.2): the cell with the focus (for the table bar), a cell that should get
    // it, a table waiting for "delete?", and a counter that lays the body out in pieces again.
    var cellFocus by remember { mutableStateOf<TableCell?>(null) }
    var tableFocus by remember { mutableStateOf<TableFocus?>(null) }
    var confirmTableDelete by remember { mutableStateOf<Int?>(null) }
    var layoutKey by remember { mutableIntStateOf(0) }
    // What the strip above the formatting bar says after a list action, with Undo (design checklists-77, 6.5).
    var notice by remember { mutableStateOf<EditorNotice?>(null) }
    // A focus request for a grid that never came (the note went raw) must not catch a later grid.
    LaunchedEffect(tableFocus) { if (tableFocus != null) { delay(1500); tableFocus = null } }
    var originalBody by rememberSaveable { mutableStateOf("") }
    var bodyEditing by rememberSaveable { mutableStateOf(initialUri == null) }
    // Expliciete titel (de eerste `# kop`-regel). Leeg → de kaart leidt zoals
    // vanouds een titel af uit de eerste woorden van de body.
    var titleText by rememberSaveable { mutableStateOf("") }
    var originalTitle by rememberSaveable { mutableStateOf("") }
    // Kop-diepte van de geladen titelregel (1 = `#`, 2 = `##`, …) — gaat mee
    // terug bij opslaan zodat het niveau de round-trip overleeft.
    var titleLevel by rememberSaveable { mutableStateOf(1) }
    // Undo and Redo (design checklists-77-v2, part 4): the note's stack of changes. It is kept outside this screen, so
    // it is still there after turning the phone and after the note is closed and opened again. A new note has a name
    // of its own until it is saved.
    val newNoteKey = rememberSaveable { "new:" + System.nanoTime() }
    var history by remember { mutableStateOf(if (loaded) EditHistories.of(currentUri ?: newNoteKey, titleText, bodyText.text) else EditHistory()) }
    var canUndo by remember { mutableStateOf(history.canUndo) }
    var canRedo by remember { mutableStateOf(history.canRedo) }
    // What Undo or Redo just changed: the note scrolls to it.
    var reveal by remember { mutableStateOf<EditApplied?>(null) }
    // Image-embed-regels (`![[basename]]`) leven los van de editor-tekst zodat ze
    // niet als ruwe markdown in beeld staan. We tonen ze als thumbnail-strip
    // boven het textveld en plakken ze terug bij opslaan.
    val embedLines = rememberSaveable(saver = stringStateListSaver) { mutableStateListOf<String>() }
    var originalEmbeds by rememberSaveable { mutableStateOf<List<String>>(emptyList()) }
    var color by rememberSaveable { mutableStateOf(NoteColor.DEFAULT) }
    var pinned by rememberSaveable { mutableStateOf(false) }
    val tags = rememberSaveable(saver = stringStateListSaver) { mutableStateListOf<String>() }
    val labels = rememberSaveable(saver = stringStateListSaver) {
        mutableStateListOf<String>().apply { initialLabel?.let { add(it) } }
    }
    var reminder by rememberSaveable { mutableStateOf<String?>(null) }
    var originalReminder by rememberSaveable { mutableStateOf<String?>(null) }
    var reminderRepeat by rememberSaveable { mutableStateOf<String?>(null) }
    var reminderUntil by rememberSaveable { mutableStateOf<String?>(null) }
    var reminderLimit by rememberSaveable { mutableStateOf<Int?>(null) }
    var reminderDone by rememberSaveable { mutableStateOf(0) }
    var saving by remember { mutableStateOf(false) }
    var showArchiveDialog by remember { mutableStateOf(false) }
    // Move/copy to a vault folder like the plugin: null = closed, true = copy, false = move.
    var folderCopy by remember { mutableStateOf<Boolean?>(null) }
    var vaultFolders by remember { mutableStateOf<List<String>?>(null) }
    var showMarkdownHelp by remember { mutableStateOf(false) }
    var showDeleteDialog by remember { mutableStateOf(false) }
    var editorMenuOpen by remember { mutableStateOf(false) }
    var labelsSheetOpen by remember { mutableStateOf(false) }
    var labelsOpening by remember { mutableStateOf(false) }
    var showColorPicker by remember { mutableStateOf(false) }
    var showLinkPicker by remember { mutableStateOf(false) }
    var photoMenuExpanded by remember { mutableStateOf(false) }
    var pendingCameraUri by rememberSaveable { mutableStateOf<Uri?>(null) }
    var pendingCameraFile by rememberSaveable { mutableStateOf<File?>(null) }
    var pendingOcr by rememberSaveable { mutableStateOf(false) }
    // Eén SAF-snapshot per editorsessie. Voorheen zocht EditorBody elk embed via
    // DocumentFile op de UI-thread; dat veroorzaakte de merkbare pauze na swipen.
    var attachmentUris by remember { mutableStateOf<Map<String, Uri>>(emptyMap()) }
    var attachmentIndexLoaded by remember { mutableStateOf(false) }

    fun historyChanged() {
        canUndo = history.canUndo
        canRedo = history.canRedo
        EditHistories.keep(currentUri ?: newNoteKey, history)
    }

    /**
     * The one place where the body is written (check:android-navigation counts them). With a [kind] the change goes on
     * the note's undo stack: typing, a step of its own, or something the editor tidies up; Undo and Redo themselves
     * pass none. [fieldText] is the text the keyboard built its change on: after a change that is not its own it may
     * still send one on the text from before, which is then replayed on ours (StaleField).
     */
    fun writeBody(next: TextFieldValue, kind: EditKind?, fieldText: String = bodyText.text) {
        val current = bodyText
        if (kind != null && next.text != current.text) {
            history.record(EditField.BODY, current.text, next.text, kind, current.selection.start, current.selection.end, next.selection.start, next.selection.end)
            historyChanged()
            // The strip told about the change before this one.
            notice = null
        } else if (kind != null && next.selection != current.selection) history.moved()
        staleBody.settle(fieldText, next.text)
        bodyText = next
    }

    /** The one place where the title is written, as [writeBody] is for the body. Its typing is on the same stack. */
    fun writeTitle(next: String, typed: Boolean = true) {
        if (typed && next != titleText) {
            history.record(EditField.TITLE, titleText, next, EditKind.TYPING)
            historyChanged()
        }
        titleText = next
    }

    /**
     * Undo and Redo (design checklists-77-v2, 4.1): the last step goes back or comes again, with the caret where it
     * was, and the note scrolls to what changed. It is no typing: the keyboard stays as it was and a note in its read
     * view stays there. A stack that no longer fits the note is dropped and nothing happens.
     */
    fun stepHistory(redo: Boolean) {
        if (saving || !loaded || loadError != null) return
        val current = bodyText
        val applied = if (redo) history.redo(titleText, current.text) else history.undo(titleText, current.text)
        historyChanged()
        if (applied == null) return
        notice = null
        writeTitle(applied.title, typed = false)
        val selection = if (applied.selFrom >= 0) TextRange(applied.selFrom, applied.selTo)
            else TextRange(current.selection.start.coerceAtMost(applied.body.length), current.selection.end.coerceAtMost(applied.body.length))
        if (applied.body != current.text || selection != current.selection) writeBody(TextFieldValue(applied.body, selection), null)
        reveal = applied
        view.announceForAccessibility(context.getString(if (redo) R.string.notice_redone else R.string.notice_undone))
    }

    fun insertImageEmbed(basename: String) {
        // Embed leeft in een aparte lijst — pas bij opslaan plakken we hem
        // terug aan de body. Voorkomt dat de gebruiker `![[…]]` als ruwe
        // markdown in z'n editor ziet.
        embedLines.add("![[" + basename + "]]")
    }

    fun insertOcrAndEmbed(basename: String, ocrText: String) {
        if (ocrText.isNotBlank()) {
            // OCR-tekst is gewone tekst en gaat wél de body in op cursorpositie.
            val current = bodyText
            val start = current.selection.start.coerceIn(0, current.text.length)
            val end = current.selection.end.coerceIn(0, current.text.length)
            val before = current.text.substring(0, start)
            val after = current.text.substring(end)
            val needsLeading = before.isNotEmpty() && !before.endsWith("\n")
            val needsTrailing = after.isNotEmpty() && !after.startsWith("\n")
            val insert = buildString {
                if (needsLeading) append("\n")
                append(ocrText.trim())
                if (needsTrailing) append("\n")
            }
            val newText = before + insert + after
            val cursorPos = before.length + insert.length
            writeBody(TextFieldValue(text = newText, selection = TextRange(cursorPos)), EditKind.STEP)
            bodyEditing = true
        }
        embedLines.add("![[" + basename + "]]")
    }

    fun handleImageUri(uri: Uri, cleanupFile: File?, withOcr: Boolean, name: String? = null, replaces: String? = null) {
        scope.launch {
            if (withOcr) {
                Toast.makeText(context, R.string.ocr_running, Toast.LENGTH_SHORT).show()
            }
            // OCR draait op de bron-Uri vóór de kopie zodat de read-permission die
            // bij PickVisualMedia/TakePicture is gegrant nog geldig is.
            val ocrText: String = if (withOcr) {
                OcrService.recognizeFromUri(context, uri).getOrElse { err ->
                    Toast.makeText(
                        context,
                        context.getString(R.string.ocr_failed, err.message ?: err.javaClass.simpleName),
                        Toast.LENGTH_LONG,
                    ).show()
                    ""
                }
            } else ""

            if (withOcr && ocrText.isBlank()) {
                Toast.makeText(context, R.string.ocr_no_text, Toast.LENGTH_SHORT).show()
            }

            val result = withContext(Dispatchers.IO) {
                Storage.copyImageToAttachments(context, uri, Storage.spaceIdOf(initialUri), name)
            }
            cleanupFile?.delete()
            val basename = result.getOrNull()
            if (basename != null) {
                val hadCompleteIndex = attachmentIndexLoaded
                val refreshed = withContext(Dispatchers.IO) {
                    if (hadCompleteIndex) {
                        Storage.findAttachmentUri(context, basename, Storage.spaceIdOf(initialUri))?.let { mapOf(basename to it) }.orEmpty()
                    } else {
                        Storage.listAttachmentUris(context, Storage.spaceIdOf(initialUri))
                    }
                }
                attachmentUris = if (hadCompleteIndex) attachmentUris + refreshed else refreshed
                attachmentIndexLoaded = true
                val old = replaces?.let { "![[" + it + "]]" }?.let(embedLines::indexOf) ?: -1
                if (old >= 0) embedLines[old] = "![[" + basename + "]]"
                else if (withOcr) insertOcrAndEmbed(basename, ocrText)
                else insertImageEmbed(basename)
            } else {
                val err = result.exceptionOrNull()
                Toast.makeText(
                    context,
                    context.getString(
                        R.string.photo_error,
                        err?.message ?: err?.javaClass?.simpleName ?: context.getString(R.string.error_unknown),
                    ),
                    Toast.LENGTH_SHORT,
                ).show()
            }
        }
    }

    val takePictureLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.TakePicture()
    ) { success ->
        val uri = pendingCameraUri
        val file = pendingCameraFile
        val ocr = pendingOcr
        pendingCameraUri = null
        pendingCameraFile = null
        pendingOcr = false
        if (success && uri != null) {
            handleImageUri(uri, cleanupFile = file, withOcr = ocr)
        } else {
            file?.delete()
        }
    }

    // A drawing goes into the note like a photo, under its own name so it opens again to draw on.
    val drawLauncher = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        val path = result.data?.getStringExtra(DrawingActivity.RESULT_FILE) ?: return@rememberLauncherForActivityResult
        val file = File(path)
        handleImageUri(Uri.fromFile(file), cleanupFile = file, withOcr = false, name = file.name)
    }
    // Drawing on an existing drawing: the new picture takes the place of the old one in this note.
    var editingDrawing by rememberSaveable { mutableStateOf<String?>(null) }
    val editDrawingLauncher = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        val replaced = editingDrawing
        editingDrawing = null
        val path = result.data?.getStringExtra(DrawingActivity.RESULT_FILE) ?: return@rememberLauncherForActivityResult
        val file = File(path)
        handleImageUri(Uri.fromFile(file), cleanupFile = file, withOcr = false, name = file.name, replaces = replaced)
    }
    // Attach file: any file, several at once, like the website and the plugin. A file over the plan's maximum is refused at once.
    var attachProblems by remember { mutableStateOf<List<String>>(emptyList()) }
    val pickFilesLauncher = rememberLauncherForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { uris ->
        if (uris.isEmpty()) return@rememberLauncherForActivityResult
        scope.launch {
            val spaceId = Storage.spaceIdOf(initialUri)
            val outcome = withContext(Dispatchers.IO) { Attachments.copy(context, uris, spaceId) }
            if (outcome.names.isNotEmpty()) {
                val hadCompleteIndex = attachmentIndexLoaded
                val refreshed = withContext(Dispatchers.IO) {
                    if (hadCompleteIndex) outcome.names.mapNotNull { name -> Storage.findAttachmentUri(context, name, spaceId)?.let { name to it } }.toMap()
                    else Storage.listAttachmentUris(context, spaceId)
                }
                attachmentUris = if (hadCompleteIndex) attachmentUris + refreshed else refreshed
                attachmentIndexLoaded = true
                for (name in outcome.names) insertImageEmbed(name)
                Attachments.toastAttached(context, outcome.names)
            }
            attachProblems = outcome.problems
        }
    }
    val pickImageLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.PickVisualMedia()
    ) { uri ->
        val ocr = pendingOcr
        pendingOcr = false
        if (uri != null) handleImageUri(uri, cleanupFile = null, withOcr = ocr)
    }

    fun launchCamera(withOcr: Boolean) {
        val file = File(context.cacheDir, "camera-${System.currentTimeMillis()}.jpg")
        val uri = try {
            FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", file)
        } catch (e: Exception) {
            Toast.makeText(
                context,
                context.getString(R.string.camera_error, e.message ?: e.javaClass.simpleName),
                Toast.LENGTH_SHORT,
            ).show()
            return
        }
        pendingCameraUri = uri
        pendingCameraFile = file
        pendingOcr = withOcr
        try {
            takePictureLauncher.launch(uri)
        } catch (e: Exception) {
            pendingCameraUri = null
            pendingCameraFile = null
            pendingOcr = false
            file.delete()
            Toast.makeText(context, R.string.no_camera_app, Toast.LENGTH_SHORT).show()
        }
    }

    fun launchPicker(withOcr: Boolean) {
        pendingOcr = withOcr
        pickImageLauncher.launch(
            PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)
        )
    }

    // The Checklist button, through the shared core as in the web app (design checklists-77, 6.4): a task at any
    // level ticks, a bullet or a numbered line becomes a task, any other line gets a box.
    fun toggleOrInsertChecklist() {
        val current = bodyText
        val edit = FormatCore.checklistEdit(current.text, current.selection.min, current.selection.max, Storage.getMoveChecked(context)) ?: return
        writeBody(TextFieldValue(current.text.replaceRange(edit.from, edit.to, edit.insert), TextRange(edit.selFrom, edit.selTo)), EditKind.STEP)
        bodyEditing = true
    }

    /**
     * One level in or out for the list items the selection touches (design checklists-77, 6.3): the Indent and Outdent
     * buttons, and Tab and Shift+Tab from a keyboard. False when the selection is on no list line: then Tab stays the
     * field's own key. On a list line it is ours, also when the item cannot move, as in the web app.
     */
    fun indentBody(direction: String): Boolean {
        val current = bodyText
        val from = current.selection.min
        val to = current.selection.max
        val edit = FormatCore.indentEdit(current.text, from, to, direction)
        if (edit == null) {
            val first = current.text.substring(0, from).count { it == '\n' }
            val last = first + current.text.substring(from, to).count { it == '\n' }
            val levels = FormatCore.listLevels(current.text)
            return (first..last).any { levels.getOrElse(it) { -1 } >= 0 } ||
                FormatCore.indentEdit(current.text, from, to, if (direction == "in") "out" else "in") != null
        }
        writeBody(TextFieldValue(current.text.replaceRange(edit.from, edit.to, edit.insert), TextRange(edit.selFrom, edit.selTo)), EditKind.STEP)
        bodyEditing = true
        return true
    }

    /** A formatting button (shared core, format.mjs and FormatCore.kt): one small replacement in the body. */
    fun applyBodyFormat(command: String) {
        val current = bodyText
        val next = current.withFormat(command) ?: return
        writeBody(next, EditKind.STEP)
        bodyEditing = true
        // A new table becomes a grid at once, with the focus in its first cell (the selection is at its start).
        if (command == "table" && !markdownMode && next.text.length <= FORMAT_RAW_ABOVE) {
            layoutKey++
            tableFocus = TableFocus(FormatCore.blocks(next.text).count { it.kind == "table" && it.from < next.selection.min }, 0, 0)
        }
    }

    /** One change to the [table]-th table of the body (FormatCore.tableEdit: only the lines it must touch). */
    fun editTable(table: Int, op: FormatCore.TableOp) {
        val current = bodyText
        val run = FormatCore.blocks(current.text).filter { it.kind == "table" }.getOrNull(table) ?: return
        val edit = FormatCore.tableEdit(current.text, run.fromLine, op) ?: return
        // What is typed in a cell is typing; a row or a column that comes or goes is a step of its own.
        writeBody(TextFieldValue(current.text.replaceRange(edit.from, edit.to, edit.insert), TextRange(edit.selFrom)), if (op.type == "setCell") EditKind.TYPING else EditKind.STEP)
        bodyEditing = true
    }

    // A list action from a grip, the More menu, the note's menu, a screen reader or a keyboard (design checklists-77,
    // part 6): one replacement from the shared core, and one step for Undo. It is no typing: the keyboard stays as it
    // was and a note in its read view stays there.
    fun replaceBody(current: TextFieldValue, edit: FormatCore.Edit, selection: TextRange = TextRange(edit.selFrom, edit.selTo)) {
        writeBody(TextFieldValue(current.text.replaceRange(edit.from, edit.to, edit.insert), selection), EditKind.STEP)
    }

    /**
     * An item let go after a drag by its handle (6.1): it lands in front of line [before], on [level], with what is
     * under it. No strip (design checklists-77-v2, 4.5): the move is there to see, and Undo is always in sight. False
     * when nothing changed.
     */
    fun dropItem(line: Int, before: Int, level: Int): Boolean {
        val current = bodyText
        val moved = FormatCore.dropItemEdit(current.text, line, before, level, current.selection.min, current.selection.max) ?: return false
        replaceBody(current, moved.edit)
        return true
    }

    /**
     * Deletes the item [line] belongs to, with what is under it (6.2); without [line] it is the item with the caret.
     * No question, Undo brings it back. The strip only says something when more went than was seen: the items under
     * it (design checklists-77-v2, 4.5). False when the line is in no list.
     */
    fun deleteItem(line: Int? = null): Boolean {
        val current = bodyText
        val at = line ?: lineOf(current.text, current.selection.min)
        val deleted = FormatCore.deleteItemEdit(current.text, at, current.selection.min, current.selection.max) ?: return false
        replaceBody(current, deleted.edit)
        if (deleted.count > 0) notice = EditorNotice(context.resources.getQuantityString(R.plurals.notice_item_deleted_subs, deleted.count, deleted.count))
        return true
    }

    /**
     * Move up or Move down (6.4, 6.7): the item trades places with the sibling above or under it. Without [line] it is
     * the item with the caret; with [line] a screen reader asked, and hears the new place. False when the line is in
     * no list; true also when the item cannot go further, so a key pressed for it never types.
     */
    fun moveItem(direction: String, line: Int? = null): Boolean {
        val current = bodyText
        val at = line ?: lineOf(current.text, current.selection.min)
        val moved = FormatCore.moveItemEdit(current.text, at, direction, current.selection.min, current.selection.max)
            ?: return FormatCore.listItems(current.text).getOrElse(at) { -1 } >= 0
        replaceBody(current, moved.edit)
        if (line != null) FormatCore.itemSpan(bodyText.text, moved.line)?.let {
            view.announceForAccessibility(context.getString(R.string.list_item_place, it.place, it.of))
        }
        return true
    }

    // What a screen reader offers on a task's box (6.7): the same moves as the handle, the buttons and the cross, on
    // that task wherever the caret is. False when nothing changed.
    fun itemAction(line: Int, action: String): Boolean {
        val current = bodyText
        return when (action) {
            "up", "down" -> moveItem(action, line) && bodyText.text != current.text
            "delete" -> deleteItem(line)
            else -> {
                val start = lineStartOf(current.text, line)
                val edit = FormatCore.indentEdit(current.text, start, start, action) ?: return false
                replaceBody(current, edit, TextRange(edit.moved(current.selection.start), edit.moved(current.selection.end)))
                true
            }
        }
    }

    // The note's menu (6.4): every ticked task gets an empty box again, or goes. The strip says what happened: the
    // menu covered the note, and tasks out of sight changed too. Undo brings them back.
    fun uncheckAll() {
        val current = bodyText
        val unticked = FormatCore.uncheckAllEdit(current.text, current.selection.min, current.selection.max) ?: return
        replaceBody(current, unticked.edit)
        notice = EditorNotice(context.getString(R.string.notice_all_unchecked))
    }

    fun deleteChecked() {
        val current = bodyText
        val deleted = FormatCore.deleteCheckedEdit(current.text, current.selection.min, current.selection.max) ?: return
        replaceBody(current, deleted.edit)
        notice = EditorNotice(context.resources.getQuantityString(R.plurals.notice_checked_deleted, deleted.count, deleted.count))
    }

    // A tap on a box in the open note (#77, Eric 22 Nov): the same tick as on the card, the setting to move included.
    // It is no typing: the keyboard stays away and a note in its read view stays there.
    fun tickTask(line: Int) {
        val current = bodyText
        val tick = FormatCore.tickEdit(current.text, line, Storage.getMoveChecked(context), current.selection.min, current.selection.max) ?: return
        replaceBody(current, tick.edit)
    }

    fun insertEmoji(emoji: String) {
        val current = bodyText
        val start = current.selection.min.coerceIn(0, current.text.length)
        val end = current.selection.max.coerceIn(0, current.text.length)
        writeBody(TextFieldValue(current.text.replaceRange(start, end, emoji), TextRange(start + emoji.length)), EditKind.STEP)
        bodyEditing = true
    }

    fun insertText(text: String) {
        if (text.isEmpty()) return
        val current = bodyText
        val start = current.selection.start.coerceIn(0, current.text.length)
        val end = current.selection.end.coerceIn(0, current.text.length)
        val before = current.text.substring(0, start)
        val after = current.text.substring(end)
        // Spatie tussen bestaande tekst en spraakresultaat, behalve direct na
        // een spatie of regelafbreking — voorkomt "samengeplakte" zinnen.
        val needsLeadingSpace = before.isNotEmpty() && !before.last().isWhitespace()
        val prefix = if (needsLeadingSpace) " " else ""
        val insert = prefix + text
        val newText = before + insert + after
        val cursorPos = before.length + insert.length
        writeBody(TextFieldValue(text = newText, selection = TextRange(cursorPos)), EditKind.STEP)
        bodyEditing = true
    }

    val speechLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        if (result.resultCode != Activity.RESULT_OK) return@rememberLauncherForActivityResult
        val matches = result.data?.getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS)
        val recognized = matches?.firstOrNull()?.trim().orEmpty()
        if (recognized.isNotEmpty()) insertText(recognized)
    }

    // Ask JotDrop on the draft: the answer replaces the text or follows it, and is saved like any edit.
    val aiLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        val answer = result.data?.getStringExtra(AskActivity.RESULT_TEXT)
        if (result.resultCode != Activity.RESULT_OK || answer.isNullOrBlank()) return@rememberLauncherForActivityResult
        val text = if (result.data?.getBooleanExtra(AskActivity.RESULT_REPLACE, false) == true) AiNoteEdits.draftBody(titleText, answer)
            else AiNoteEdits.appendedText(bodyText.text, answer, null).trimEnd('\r', '\n')
        writeBody(TextFieldValue(text = text, selection = TextRange(text.length)), EditKind.STEP)
        bodyEditing = true
    }

    fun askAboutDraft(kind: String) {
        when {
            bodyText.text.isBlank() -> Toast.makeText(context, R.string.ai_write_first, Toast.LENGTH_SHORT).show()
            // Keeps the hand-over below Android's limit for what one screen can pass to the next.
            bodyText.text.length > 200_000 -> Toast.makeText(context, R.string.ai_too_long, Toast.LENGTH_LONG).show()
            else -> aiLauncher.launch(AskActivity.draftIntent(context, kind, titleText, bodyText.text))
        }
    }

    fun launchSpeech() {
        val lang = Storage.getSpeechLanguage(context)
        val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
            putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            putExtra(RecognizerIntent.EXTRA_LANGUAGE, lang)
            putExtra(RecognizerIntent.EXTRA_LANGUAGE_PREFERENCE, lang)
            putExtra(RecognizerIntent.EXTRA_PROMPT, context.getString(R.string.speech_prompt))
            putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1)
            // Bewust GEEN EXTRA_PREFER_OFFLINE — Google's Voice Search behandelt
            // die vlag als harde eis i.p.v. hint, en weigert dan zonder lokaal
            // taalpakket ("Voice search isn't available"). Zonder de vlag wordt
            // offline automatisch gebruikt als het pakket geïnstalleerd is.
        }
        try {
            speechLauncher.launch(intent)
        } catch (e: Exception) {
            Toast.makeText(context, R.string.speech_unavailable, Toast.LENGTH_SHORT).show()
        }
    }

    // Laadt een notitie in alle editor-state. Ook gebruikt door de
    // prev/next-navigatie, vandaar losgetrokken uit de LaunchedEffect.
    suspend fun loadInto(uriString: String) {
        loaded = false
        loadError = null
        parkedUri = null
        notice = null
        reveal = null
        val cachedAttachments = attachmentUris.takeIf { attachmentIndexLoaded }
        val result = withContext(Dispatchers.IO) {
            runCatching {
                val raw = Storage.readNote(context, Uri.parse(uriString)).getOrThrow()
                val embedded = Storage.findEmbeddedAttachmentBasenames(raw)
                val fromList = initialThumbnail?.takeIf {
                    uriString == initialUri?.toString() && embedded.size == 1 && embedded[0] == it.first
                }?.let { mapOf(it) }
                val shouldBuildIndex = cachedAttachments == null && embedded.isNotEmpty() && fromList == null
                Triple(
                    raw,
                    cachedAttachments ?: fromList ?: if (shouldBuildIndex) Storage.listAttachmentUris(context, Storage.spaceIdOf(initialUri)) else emptyMap(),
                    cachedAttachments != null || shouldBuildIndex,
                )
            }
        }
        result.onSuccess { (raw, attachments, indexReady) ->
            try {
                attachmentUris = attachments
                attachmentIndexLoaded = indexReady
                val parsed = FrontmatterParser.parse(raw)
                loadedBodyHash = editorBodyHash(parsed.body)
                val cleanBody = parsed.body.removePrefix("\n")
                val (textPart, embeds) = splitBodyAndEmbeds(cleanBody)
                val (loadedTitle, loadedBody, loadedLevel) = splitHeadingTitle(textPart)
                titleText = loadedTitle
                originalTitle = loadedTitle
                titleLevel = loadedLevel
                bodyText = TextFieldValue(loadedBody)
                bodyEditing = false
                originalBody = loadedBody
                embedLines.clear()
                embedLines.addAll(embeds)
                originalEmbeds = embeds.toList()
                color = parsed.meta.color
                pinned = parsed.meta.pinned
                tags.clear()
                tags.addAll(parsed.meta.tags)
                labels.clear()
                labels.addAll(parsed.meta.labels)
                reminder = parsed.meta.reminder
                originalReminder = parsed.meta.reminder
                reminderRepeat = parsed.meta.reminderRepeat
                reminderUntil = parsed.meta.reminderUntil
                reminderLimit = parsed.meta.reminderLimit
                reminderDone = parsed.meta.reminderDone
                currentUri = uriString
                // The note's own stack when it is as that stack left it; changed since (a tick on the card, the sync,
                // another device), it starts a new one.
                history = EditHistories.of(uriString, loadedTitle, loadedBody)
                historyChanged()
            } catch (e: Throwable) {
                loadError = context.getString(R.string.parse_error, e.message ?: e.javaClass.simpleName)
            }
            loaded = true
        }.onFailure { err ->
            loadError = err.message ?: context.getString(R.string.error_unknown)
            if (err is Storage.ParkedSaveException) parkedUri = uriString
            loaded = true
        }
    }

    fun resolveParked(keepCopy: Boolean) {
        val uri = parkedUri ?: return
        parkedBusy = true
        val appContext = context.applicationContext
        scope.launch {
            // Niet afbreekbaar: bij een draai tijdens de actie hoort de melding nog steeds bij het resultaat.
            val res = withContext(NonCancellable + Dispatchers.IO) {
                val res = Storage.noteWriteMutex.withLock {
                    runCatching {
                        if (keepCopy) Storage.keepParkedSaveAsCopy(appContext, Uri.parse(uri)).getOrThrow()
                        else Storage.discardParkedSave(appContext, Uri.parse(uri)).let { Storage.ParkedResolution.Released }
                    }
                }
                val message = res.fold(
                    onSuccess = { resolution ->
                        when (resolution) {
                            is Storage.ParkedResolution.Copied -> appContext.getString(R.string.parked_copy_saved, resolution.name)
                            Storage.ParkedResolution.Released -> if (keepCopy) appContext.getString(R.string.parked_nothing_to_keep) else null
                        }
                    },
                    onFailure = { err -> appContext.getString(R.string.toast_error, err.message ?: "") },
                )
                if (message != null) withContext(Dispatchers.Main) { Toast.makeText(appContext, message, Toast.LENGTH_LONG).show() }
                res
            }
            parkedBusy = false
            if (res.isSuccess && parkedUri == uri) loadInto(uri)
        }
    }

    LaunchedEffect(initialUri) {
        if (initialUri != null && !loaded) {
            loadInto(initialUri.toString())
        }
    }

    // Na een draai (ook tijdens Keep/Discard) kan de geparkeerde opslag al opgelost zijn: na de lopende actie opnieuw kijken.
    LaunchedEffect(Unit) {
        val uri = parkedUri ?: return@LaunchedEffect
        parkedBusy = true
        withContext(Dispatchers.IO) { Storage.noteWriteMutex.withLock {} }
        parkedBusy = false
        if (parkedUri == uri) loadInto(uri)
    }

    // Na een mislukte load (bv. naar een geparkeerde notitie gebladerd) hoort de oude editor-state bij geen notitie meer.
    val isDirty = loaded && loadError == null && (bodyText.withoutEmptyPair().text != originalBody || titleText != originalTitle || embedLines.toList() != originalEmbeds)
    val isExisting = currentUri != null
    val bg = noteBackground(color, dark)
    val fg = contentColorOn(color, dark)
    // DEFAULT-notities krijgen de sunset-screen-gradient; gekleurde notities
    // krijgen een lichte diagonale gradient op hun pastel zodat het kaart-gevoel
    // doorloopt in de editor. Memoizen voorkomt nieuwe Brush per recomposition.
    val editorBrush = remember(color, dark, bg) {
        if (color == NoteColor.DEFAULT) screenBackgroundBrush(dark) else noteCardBrush(bg, dark)
    }
    val embedBasenames = embedLines.mapNotNull { extractEmbedBasename(it) }
    val embedItems = remember(embedBasenames, attachmentUris) {
        embedBasenames.mapNotNull { name -> attachmentUris[name]?.let { uri -> name to uri } }
    }

    fun applyMetaAsync(
        newColor: NoteColor = color,
        newPinned: Boolean = pinned,
        newTags: List<String> = tags.toList(),
        newReminder: String? = reminder,
        newRepeat: String? = reminderRepeat,
        newUntil: String? = reminderUntil,
        newLimit: Int? = reminderLimit,
        newDone: Int = reminderDone,
    ) {
        val uri = currentUri ?: return
        val reminderChanged = newReminder != originalReminder
        scope.launch {
            val newMeta = NoteMeta(
                color = newColor, tags = newTags, pinned = newPinned,
                reminder = newReminder, reminderRepeat = newRepeat,
                reminderUntil = newUntil, reminderLimit = newLimit, reminderDone = newDone,
            )
            withContext(Dispatchers.IO) {
                // Onder de schrijf-mutex: updateNoteMeta is read-modify-write en
                // mag niet verweven raken met een gelijktijdige body-save.
                Storage.noteWriteMutex.withLock {
                    Storage.updateNoteMeta(context, Uri.parse(uri), newMeta)
                }
            }
            // Alleen reschedulen als de reminder daadwerkelijk wijzigde — anders
            // burnen we onnodig AlarmManager-calls bij tag/kleur/pin-updates.
            if (reminderChanged) {
                val parsedUri = Uri.parse(uri)
                ReminderScheduler.cancel(context, parsedUri)
                if (!newReminder.isNullOrBlank()) {
                    ReminderScheduler.schedule(context, parsedUri, newReminder)
                }
                originalReminder = newReminder
            }
        }
    }

    // The note is saved and will be read back a little different: the edges of the title and the body trimmed, and a
    // first line that is a heading as the title. The stack takes that as a cleanup, so it still fits the note when it
    // is opened again (design checklists-77-v2, 4.3). A body with a line that is read back as an attachment gets a new
    // stack: taking that back would put the attachment in the note twice.
    fun historySaved(newUri: Uri?) {
        val (text, embeds) = splitBodyAndEmbeds(combineBodyAndEmbeds(joinHeadingTitle(titleText, bodyText.text, titleLevel), embedLines.toList()))
        val (title, body) = splitHeadingTitle(text)
        if (embeds == embedLines.toList()) history.settle(title, body) else history = EditHistory(title, body)
        if (newUri != null) EditHistories.rename(newNoteKey, newUri.toString())
        historyChanged()
    }

    fun closeWithSaveIfNeeded() {
        writeBody(bodyText.withoutEmptyPair(), EditKind.CLEANUP)
        val reminderAtSave = reminder
        attemptSaveAndClose(
            scope = scope,
            context = context,
            bodyText = bodyText.text,
            title = titleText,
            titleLevel = titleLevel,
            embedLines = embedLines.toList(),
            currentUri = currentUri,
            expectedBodyHash = loadedBodyHash,
            color = color,
            pinned = pinned,
            tags = tags.toList(),
            labels = labels.toList(),
            reminder = reminderAtSave,
            reminderRepeat = reminderRepeat,
            reminderUntil = reminderUntil,
            reminderLimit = reminderLimit,
            reminderDone = reminderDone,
            isDirty = isDirty,
            onSavingChange = { saving = it },
            onSaved = { newUri ->
                if (newUri != null) currentUri = newUri.toString()
                historySaved(newUri)
                originalBody = bodyText.text
                originalTitle = titleText
                originalEmbeds = embedLines.toList()
                // Bij nieuwe notitie krijgen we hier de definitieve URI binnen
                // — pas dan kunnen we de reminder schedulen (cancel-old is een
                // no-op want er was nog niets).
                val finalUri = newUri ?: currentUri?.let { Uri.parse(it) }
                if (finalUri != null) {
                    ReminderScheduler.cancel(context, finalUri)
                    if (!reminderAtSave.isNullOrBlank()) {
                        ReminderScheduler.schedule(context, finalUri, reminderAtSave)
                    }
                    originalReminder = reminderAtSave
                }
                onClose()
            },
            onError = { msg ->
                Toast.makeText(context, msg, Toast.LENGTH_LONG).show()
            },
            onConflict = { current -> saveConflict = current to { closeWithSaveIfNeeded() } },
            closeWhenClean = true,
            onClose = onClose,
        )
    }

    // Vorige/volgende notitie uit de kaartvolgorde. Onopgeslagen wijzigingen
    // worden eerst opgeslagen (zelfde pad als de save-knop); een save-fout
    // annuleert de navigatie zodat er niets verloren gaat.
    fun navigateTo(delta: Int) {
        if (!navEnabled || saving || !loaded || parkedBusy) return
        val target = navIndex + delta
        if (target < 0 || target >= navUris.size) return
        val proceed: () -> Unit = {
            navIndex = target
            scope.launch { loadInto(navUris[target]) }
        }
        if (isDirty && currentUri != null) {
            writeBody(bodyText.withoutEmptyPair(), EditKind.CLEANUP)
            val reminderAtSave = reminder
            attemptSaveAndClose(
                scope = scope,
                context = context,
                bodyText = bodyText.text,
                title = titleText,
                titleLevel = titleLevel,
                embedLines = embedLines.toList(),
                currentUri = currentUri,
                expectedBodyHash = loadedBodyHash,
                color = color,
                pinned = pinned,
                tags = tags.toList(),
                labels = labels.toList(),
                reminder = reminderAtSave,
                reminderRepeat = reminderRepeat,
                reminderUntil = reminderUntil,
                reminderLimit = reminderLimit,
                reminderDone = reminderDone,
                isDirty = true,
                onSavingChange = { saving = it },
                onSaved = {
                    historySaved(null)
                    // Reminder herschedulen zoals de save-knop dat doet.
                    val finalUri = currentUri?.let { Uri.parse(it) }
                    if (finalUri != null) {
                        ReminderScheduler.cancel(context, finalUri)
                        if (!reminderAtSave.isNullOrBlank()) {
                            ReminderScheduler.schedule(context, finalUri, reminderAtSave)
                        }
                        originalReminder = reminderAtSave
                    }
                    proceed()
                },
                onError = { msg ->
                    Toast.makeText(context, msg, Toast.LENGTH_LONG).show()
                },
                onConflict = { current -> saveConflict = current to { navigateTo(delta) } },
                closeWhenClean = false,
                onClose = {},
            )
        } else {
            proceed()
        }
    }

    BackHandler(enabled = true) { closeWithSaveIfNeeded() }

    Box(modifier = Modifier.fillMaxSize().background(brush = editorBrush)) {
    Scaffold(
        containerColor = Color.Transparent,
        topBar = {
            // Seven 48 dp buttons do not fit a 360 dp phone: there the bar keeps the buttons at their own 40 dp.
            CompositionLocalProvider(
                LocalMinimumInteractiveComponentEnforcement provides (LocalConfiguration.current.screenWidthDp >= 400),
            ) {
            TopAppBar(
                title = { /* geen titel — geeft ruimte aan acties op smalle schermen */ },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = Color.Transparent,
                    scrolledContainerColor = Color.Transparent,
                ),
                navigationIcon = {
                    IconButton(onClick = { closeWithSaveIfNeeded() }) {
                        Icon(
                            Icons.AutoMirrored.Filled.ArrowBack,
                            contentDescription = stringResource(R.string.action_back),
                        )
                    }
                },
                actions = {
                    // Zonder geladen notitie (bv. geparkeerd) zouden deze acties op een vorige of verkeerde notitie werken.
                    if (loadError == null) {
                        // Pin and labels are per person, and a reminder would go off for everyone: not in a shared note.
                        if (Storage.spaceIdOf(initialUri) == null) IconButton(onClick = {
                            pinned = !pinned
                            if (isExisting) applyMetaAsync(newPinned = pinned)
                        }) {
                            Icon(
                                Icons.Filled.PushPin,
                                contentDescription = stringResource(if (pinned) R.string.action_unpin else R.string.action_pin),
                                tint = if (pinned) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurface,
                            )
                        }
                        IconButton(onClick = { toggleOrInsertChecklist() }) {
                            Icon(Icons.Filled.CheckBox, contentDescription = stringResource(R.string.action_checklist))
                        }
                        IconButton(onClick = { launchSpeech() }) {
                            Icon(Icons.Filled.Mic, contentDescription = stringResource(R.string.action_speech))
                        }
                        // Attach file has its own button next to the photo button: nobody looks for a file in the photo menu.
                        IconButton(onClick = {
                            runCatching { pickFilesLauncher.launch(arrayOf("*/*")) }.onFailure {
                                Toast.makeText(context, context.getString(R.string.toast_error, it.message ?: ""), Toast.LENGTH_SHORT).show()
                            }
                        }) {
                            Icon(Icons.Filled.AttachFile, contentDescription = stringResource(R.string.action_attach_file))
                        }
                        Box {
                            IconButton(onClick = { photoMenuExpanded = true }) {
                                Icon(Icons.Filled.AddAPhoto, contentDescription = stringResource(R.string.action_insert_photo))
                            }
                            DropdownMenu(
                                expanded = photoMenuExpanded,
                                onDismissRequest = { photoMenuExpanded = false },
                            ) {
                                DropdownMenuItem(
                                    text = { Text(stringResource(R.string.action_take_photo)) },
                                    leadingIcon = { Icon(Icons.Filled.CameraAlt, contentDescription = null) },
                                    onClick = {
                                        photoMenuExpanded = false
                                        launchCamera(withOcr = false)
                                    },
                                )
                                DropdownMenuItem(
                                    text = { Text(stringResource(R.string.action_pick_from_gallery)) },
                                    leadingIcon = { Icon(Icons.Filled.Image, contentDescription = null) },
                                    onClick = {
                                        photoMenuExpanded = false
                                        launchPicker(withOcr = false)
                                    },
                                )
                                DropdownMenuItem(
                                    text = { Text(stringResource(R.string.action_insert_drawing)) },
                                    leadingIcon = { Icon(Icons.Filled.Draw, contentDescription = null) },
                                    onClick = {
                                        photoMenuExpanded = false
                                        drawLauncher.launch(Intent(context, DrawingActivity::class.java))
                                    },
                                )
                                DropdownMenuItem(
                                    text = { Text(stringResource(R.string.action_ocr_camera)) },
                                    leadingIcon = { Icon(Icons.Filled.TextFields, contentDescription = null) },
                                    onClick = {
                                        photoMenuExpanded = false
                                        launchCamera(withOcr = true)
                                    },
                                )
                                DropdownMenuItem(
                                    text = { Text(stringResource(R.string.action_ocr_gallery)) },
                                    leadingIcon = { Icon(Icons.Filled.TextFields, contentDescription = null) },
                                    onClick = {
                                        photoMenuExpanded = false
                                        launchPicker(withOcr = true)
                                    },
                                )
                            }
                        }
                        Box {
                            IconButton(onClick = { editorMenuOpen = true }) {
                                Icon(Icons.Filled.MoreVert, contentDescription = stringResource(R.string.more_options))
                            }
                            DropdownMenu(expanded = editorMenuOpen, onDismissRequest = { editorMenuOpen = false }) {
                                DropdownMenuItem(
                                    text = { Text(stringResource(R.string.action_color)) },
                                    leadingIcon = { Icon(Icons.Filled.Palette, null) },
                                    onClick = { editorMenuOpen = false; showColorPicker = true },
                                )
                                DropdownMenuItem(
                                    text = { Text(stringResource(R.string.action_link)) },
                                    leadingIcon = { Icon(Icons.Filled.Link, null) },
                                    onClick = { editorMenuOpen = false; showLinkPicker = true },
                                )
                                if (Storage.spaceIdOf(initialUri) == null) DropdownMenuItem(
                                    text = { Text(stringResource(R.string.nav_labels)) },
                                    leadingIcon = { Icon(Icons.Filled.Label, null) },
                                    enabled = loaded && loadError == null && !saving && !labelsOpening,
                                    onClick = {
                                        editorMenuOpen = false
                                        val targetUri = currentUri
                                        if (targetUri == null) {
                                            labelsSheetOpen = true
                                        } else {
                                            labelsOpening = true
                                            scope.launch {
                                                val result = withContext(Dispatchers.IO) {
                                                    Storage.noteWriteMutex.withLock { Storage.readNote(context, Uri.parse(targetUri)) }
                                                }
                                                labelsOpening = false
                                                if (targetUri == currentUri) result.onSuccess { content ->
                                                    labels.clear()
                                                    labels.addAll(FrontmatterParser.parse(content).meta.labels)
                                                    labelsSheetOpen = true
                                                }.onFailure { err ->
                                                    Toast.makeText(context, context.getString(R.string.toast_error, err.message ?: ""), Toast.LENGTH_LONG).show()
                                                }
                                            }
                                        }
                                    },
                                )
                                // A note with tasks (design checklists-77, 6.4): untick them all, delete the ticked ones,
                                // and the setting that moves a ticked task down, with a ✓ when it is on.
                                if (loaded && loadError == null && remember(bodyText.text) { hasTask(bodyText.text) }) {
                                    HorizontalDivider()
                                    DropdownMenuItem(
                                        text = { Text(stringResource(R.string.list_uncheck_all)) },
                                        leadingIcon = { Icon(Icons.Filled.CheckBoxOutlineBlank, null) },
                                        enabled = !saving && remember(bodyText.text) { FormatCore.uncheckAllEdit(bodyText.text) != null },
                                        onClick = { editorMenuOpen = false; uncheckAll() },
                                    )
                                    DropdownMenuItem(
                                        text = { Text(stringResource(R.string.list_delete_checked)) },
                                        leadingIcon = { Icon(Icons.Filled.DeleteSweep, null) },
                                        enabled = !saving && remember(bodyText.text) { FormatCore.deleteCheckedEdit(bodyText.text) != null },
                                        onClick = { editorMenuOpen = false; deleteChecked() },
                                    )
                                    // The menu stays open, so the ✓ shows at once.
                                    var moveChecked by remember { mutableStateOf(Storage.getMoveChecked(context)) }
                                    DropdownMenuItem(
                                        text = { Text(stringResource(R.string.move_checked_label) + if (moveChecked) "  ✓" else "") },
                                        leadingIcon = { Icon(Icons.Filled.VerticalAlignBottom, null) },
                                        onClick = {
                                            moveChecked = !moveChecked
                                            Storage.saveMoveChecked(context, moveChecked)
                                        },
                                    )
                                    HorizontalDivider()
                                }
                                for ((kind, label) in listOf("rewrite" to R.string.ai_editor_rewrite, "checklist" to R.string.ai_editor_checklist, "summarize" to R.string.ai_card_summarize)) {
                                    DropdownMenuItem(
                                        text = { Text(stringResource(label)) },
                                        leadingIcon = { Icon(Icons.Filled.AutoAwesome, null) },
                                        enabled = loaded && loadError == null && !saving,
                                        onClick = { editorMenuOpen = false; askAboutDraft(kind) },
                                    )
                                }
                                DropdownMenuItem(
                                    text = { Text(stringResource(R.string.md_help_button)) },
                                    leadingIcon = { Icon(Icons.Filled.Info, null) },
                                    onClick = { editorMenuOpen = false; showMarkdownHelp = true },
                                )
                                if (isExisting) {
                                    // Out of a group's folder means gone for everyone in it, so these are for own notes.
                                    if (Storage.spaceIdOf(initialUri) == null) DropdownMenuItem(
                                        text = { Text(stringResource(R.string.action_archive)) },
                                        leadingIcon = { Icon(Icons.Filled.Archive, null) },
                                        onClick = { editorMenuOpen = false; showArchiveDialog = true },
                                    )
                                    // Works on the saved file, so unsaved edits must be saved first.
                                    if (Storage.spaceIdOf(initialUri) == null) for (copy in listOf(false, true)) {
                                        DropdownMenuItem(
                                            text = { Text(stringResource(if (copy) R.string.action_copy_to_folder else R.string.action_move_to_folder)) },
                                            leadingIcon = { Icon(if (copy) Icons.Filled.ContentCopy else Icons.Filled.DriveFileMove, null) },
                                            enabled = loaded && loadError == null && !saving && !isDirty,
                                            onClick = {
                                                editorMenuOpen = false
                                                folderCopy = copy
                                                vaultFolders = null
                                                scope.launch {
                                                    vaultFolders = withContext(Dispatchers.IO) { Storage.listVaultFolders(context) }
                                                }
                                            },
                                        )
                                    }
                                    DropdownMenuItem(
                                        text = { Text(stringResource(R.string.action_delete)) },
                                        leadingIcon = { Icon(Icons.Filled.Delete, null) },
                                        onClick = { editorMenuOpen = false; showDeleteDialog = true },
                                    )
                                }
                            }
                        }
                        IconButton(
                            enabled = !saving && (bodyText.text.isNotBlank() || titleText.isNotBlank() || embedLines.isNotEmpty()) && (isDirty || !isExisting),
                            onClick = {
                                writeBody(bodyText.withoutEmptyPair(), EditKind.CLEANUP)
                                val reminderAtSave = reminder
                                attemptSaveAndClose(
                                    scope = scope,
                                    context = context,
                                    bodyText = bodyText.text,
                                    title = titleText,
                                    titleLevel = titleLevel,
                                    embedLines = embedLines.toList(),
                                    currentUri = currentUri,
                                    expectedBodyHash = loadedBodyHash,
                                    color = color,
                                    pinned = pinned,
                                    tags = tags.toList(),
                                    labels = labels.toList(),
                                    reminder = reminderAtSave,
                                    reminderRepeat = reminderRepeat,
                                    reminderUntil = reminderUntil,
                                    reminderLimit = reminderLimit,
                                    reminderDone = reminderDone,
                                    isDirty = true,
                                    onSavingChange = { saving = it },
                                    onSaved = { newUri ->
                                        if (newUri != null) currentUri = newUri.toString()
                                        historySaved(newUri)
                                        originalBody = bodyText.text
                                        originalTitle = titleText
                                        originalEmbeds = embedLines.toList()
                                        val finalUri = newUri ?: currentUri?.let { Uri.parse(it) }
                                        if (finalUri != null) {
                                            ReminderScheduler.cancel(context, finalUri)
                                            if (!reminderAtSave.isNullOrBlank()) {
                                                ReminderScheduler.schedule(context, finalUri, reminderAtSave)
                                            }
                                            originalReminder = reminderAtSave
                                        }
                                        Toast.makeText(context, R.string.toast_saved_short, Toast.LENGTH_SHORT).show()
                                        onClose()
                                    },
                                    onError = { msg ->
                                        Toast.makeText(context, msg, Toast.LENGTH_LONG).show()
                                    },
                                    onConflict = { current -> saveConflict = current to { closeWithSaveIfNeeded() } },
                                    closeWhenClean = false,
                                    onClose = onClose,
                                )
                            },
                        ) {
                            Icon(Icons.Filled.Check, contentDescription = stringResource(R.string.action_save))
                        }
                    }
                },
            )
            }
        },
    ) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .consumeWindowInsets(padding)
                .imePadding(),
        ) {
            // The arrows above the note go to the previous and the next one. A swipe over the editor no longer does
            // (design checklists-77-v2, 4.6): a sideways swipe is for the strip, and for selecting text.
            if (navEnabled) {
                EditorNavHeader(
                    index = navIndex,
                    total = navUris.size,
                    foreground = fg,
                    onPrev = { navigateTo(-1) },
                    onNext = { navigateTo(1) },
                )
            }
            Box(modifier = Modifier.fillMaxWidth().weight(1f)) {
            when {
                !loaded -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    CircularProgressIndicator()
                }
                parkedUri != null -> Box(Modifier.fillMaxSize().padding(24.dp), contentAlignment = Alignment.Center) {
                    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                        Text(
                            text = stringResource(R.string.parked_save_title),
                            style = MaterialTheme.typography.titleMedium,
                            color = fg,
                        )
                        Text(
                            text = stringResource(R.string.parked_save_message),
                            style = MaterialTheme.typography.bodyMedium,
                            color = fg,
                        )
                        // Bewaren is de veilige keuze en daarom de hoofdknop.
                        Button(onClick = { resolveParked(keepCopy = true) }, enabled = !parkedBusy) {
                            Text(stringResource(R.string.parked_keep_copy))
                        }
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            TextButton(
                                onClick = { parkedUri?.let { scope.launch { loadInto(it) } } },
                                enabled = !parkedBusy,
                            ) {
                                Text(stringResource(R.string.retry))
                            }
                            TextButton(onClick = { showParkedDiscard = true }, enabled = !parkedBusy) {
                                Text(stringResource(R.string.parked_discard))
                            }
                        }
                    }
                }
                loadError != null -> Box(Modifier.fillMaxSize().padding(24.dp), contentAlignment = Alignment.Center) {
                    Text(
                        text = stringResource(R.string.error_with_message, loadError ?: ""),
                        style = MaterialTheme.typography.bodyMedium,
                        color = fg,
                    )
                }
                else -> EditorBody(
                    showReminder = Storage.spaceIdOf(initialUri) == null,
                    value = bodyText,
                    onValueChange = { field, keep ->
                        val current = bodyText
                        // Right after a list edit the field can still send changes on the text from before it.
                        val replayed = staleBody.replay(current.text, field.text)
                        val next = (if (replayed == null) field else TextFieldValue(
                            text = replayed.text,
                            selection = TextRange(replayed.map(field.selection.start), replayed.map(field.selection.end)),
                            composition = field.composition?.let { TextRange(replayed.map(it.start), replayed.map(it.end)) },
                        )).let { current.backspacing(it, !markdownMode) }
                        val start = current.selection.min
                        val end = current.selection.max
                        // Only a committed single newline; leave bulk edits and IME composition alone.
                        val edit = if (next.composition == null && next.selection.collapsed &&
                            next.selection.start == start + 1 &&
                            next.text == current.text.replaceRange(start, end, "\n")
                        ) listEnterEdit(current.text, start, end) else null
                        // Keyboards often swap the word being typed in the same update as Enter.
                        val changed = if (edit == null && next.composition == null && next.selection.collapsed &&
                            next.text != current.text
                        ) listEnterAfterChange(current.text, next.text, next.selection.start) else null
                        // Text of several lines that lands in a list item, a paste mostly, becomes an item per line
                        // (design checklists-77, 6.6). After the two Enters: a word the keyboard finishes along with
                        // Enter is typing.
                        val pasted = if (edit == null && changed == null && next.composition == null && next.selection.collapsed &&
                            next.text != current.text
                        ) pastedLines(current.text, start, end, next.text, next.selection.start) else null
                        val shown = when {
                            edit != null -> TextFieldValue(
                                text = current.text.replaceRange(edit.from, edit.to, edit.insert),
                                selection = TextRange(edit.caret),
                            )
                            changed != null -> TextFieldValue(
                                text = changed.first,
                                selection = TextRange(changed.second),
                            )
                            pasted != null -> TextFieldValue(
                                text = pasted.first,
                                selection = TextRange(pasted.second),
                            )
                            else -> next
                        }.let { value ->
                            // A letter typed first in a list item becomes a capital (issue #44, point 9).
                            capitalizeListItemStart(current.text, value.text)?.let { value.copy(text = it) } ?: value
                        }.let { current.leavingEmptyPair(it) }.let { result ->
                            // A text piece next to a table: what the pipeline makes of its change may not reach into
                            // the table (a Backspace that joins the line above); then it is the field's own change.
                            if (keep == null || changedOnlyIn(current.text, result.text, keep.first, current.text.length - keep.second)) result else field
                        }
                        // For Undo: a list Enter and a paste of lines are steps of their own, an empty pair that went
                        // because the caret left it is the editor's own tidying, and the rest is typing.
                        val kind = when {
                            shown === field -> EditKind.TYPING
                            edit != null || changed != null || pasted != null -> EditKind.STEP
                            next.text == current.text -> EditKind.CLEANUP
                            else -> EditKind.TYPING
                        }
                        writeBody(shown, kind, field.text)
                    },
                    formatted = !markdownMode,
                    tableBackground = bg,
                    layoutKey = layoutKey,
                    tableFocus = tableFocus,
                    onTableFocusDone = { tableFocus = null },
                    onTableEdit = ::editTable,
                    onCell = { cellFocus = it },
                    onReplaceBody = { next ->
                        writeBody(next, EditKind.STEP)
                        bodyEditing = true
                    },
                    onBodyFocus = { focused ->
                        bodyFocused = focused
                        if (!focused) writeBody(bodyText.withoutEmptyPair(), EditKind.CLEANUP)
                    },
                    onStep = ::stepHistory,
                    reveal = reveal,
                    onRevealed = { if (reveal === it) reveal = null },
                    bodyEditing = bodyEditing,
                    onEditBody = { bodyEditing = true },
                    onTick = ::tickTask,
                    onIndent = ::indentBody,
                    items = ItemActions(drop = ::dropItem, delete = { deleteItem(it) }, act = ::itemAction, moveKey = { moveItem(it) }),
                    title = titleText,
                    onTitleChange = { writeTitle(it) },
                    embedItems = embedItems,
                    tags = tags,
                    onAddTag = { tag ->
                        val clean = tag.removePrefix("#").trim()
                        if (clean.isNotEmpty() && tags.none { it.equals(clean, ignoreCase = true) }) {
                            tags.add(clean)
                            if (isExisting) applyMetaAsync(newTags = tags.toList())
                        }
                    },
                    onRemoveTag = { tag ->
                        if (tags.remove(tag)) {
                            if (isExisting) applyMetaAsync(newTags = tags.toList())
                        }
                    },
                    reminder = reminder,
                    repeat = reminderRepeat,
                    until = reminderUntil,
                    limit = reminderLimit,
                    onReminderChange = { newIso ->
                        reminder = newIso
                        if (isExisting) {
                            reminderDone = 0
                            applyMetaAsync(newReminder = newIso, newDone = 0)
                        }
                    },
                    onRepeatChange = { newRepeat ->
                        reminderRepeat = newRepeat
                        if (isExisting) {
                            reminderDone = 0
                            applyMetaAsync(newRepeat = newRepeat, newDone = 0)
                        }
                    },
                    onUntilChange = { newUntil ->
                        reminderUntil = newUntil
                        if (isExisting) {
                            reminderDone = 0
                            applyMetaAsync(newUntil = newUntil, newDone = 0)
                        }
                    },
                    onLimitChange = { newLimit ->
                        reminderLimit = newLimit
                        if (isExisting) {
                            reminderDone = 0
                            applyMetaAsync(newLimit = newLimit, newDone = 0)
                        }
                    },
                    onClear = {
                        reminder = null
                        reminderRepeat = null
                        reminderUntil = null
                        reminderLimit = null
                        reminderDone = 0
                        if (isExisting) {
                            applyMetaAsync(
                                newReminder = null, newRepeat = null,
                                newUntil = null, newLimit = null, newDone = 0,
                            )
                        }
                    },
                    onEditDrawing = { uri ->
                        editingDrawing = Uri.decode(uri.lastPathSegment.orEmpty()).substringAfterLast('/')
                        editDrawingLauncher.launch(Intent(context, DrawingActivity::class.java).putExtra(DrawingActivity.EXTRA_SOURCE, uri.toString()))
                    },
                    // Only the link goes: the file stays in the attachments folder (Android has no trash for files).
                    onRemoveEmbed = { name -> embedLines.removeAll { extractEmbedBasename(it) == name } },
                    foreground = fg,
                )
            }
            }
            if (loaded && loadError == null && parkedUri == null) notice?.let { shown ->
                NoticeStrip(shown, fg, onGone = { if (notice === shown) notice = null })
            }
            // Undo and Redo stand at the start of whichever bar is there, always at the same place (design
            // checklists-77-v2, 4.4).
            val steps = UndoRedo(canUndo && !saving, canRedo && !saving, ::stepHistory)
            if (bodyFocused && loaded && loadError == null && parkedUri == null) {
                val active = remember(bodyText.text, bodyText.selection) {
                    if (bodyText.text.length > FORMAT_RAW_ABOVE) emptyList()
                    else FormatCore.activeFormats(bodyText.text, bodyText.selection.min, bodyText.selection.max)
                }
                FormatBar(
                    active = active,
                    markdown = markdownMode,
                    foreground = fg,
                    steps = steps,
                    onFormat = ::applyBodyFormat,
                    onChecklist = { toggleOrInsertChecklist() },
                    onIndent = { indentBody(it) },
                    // Move up, Move down and Delete item under More (design checklists-77, 6.4), for the item with the caret.
                    onItem = { action -> if (action == "delete") deleteItem() else moveItem(action) },
                    canItem = { action ->
                        val at = lineOf(bodyText.text, bodyText.selection.min)
                        if (action == "delete") FormatCore.listItems(bodyText.text).getOrElse(at) { -1 } >= 0
                        else FormatCore.moveItemEdit(bodyText.text, at, action) != null
                    },
                    onEmoji = ::insertEmoji,
                    onMarkdown = {
                        markdownMode = !markdownMode
                        EditorPrefs.setMarkdown(context, markdownMode)
                    },
                )
            } else if (loaded && loadError == null && parkedUri == null) {
                val cell = cellFocus
                if (cell != null) TableBar(
                    cell = cell,
                    foreground = fg,
                    steps = steps,
                    onOp = { op ->
                        editTable(cell.table, op)
                        // The focus goes with the row or column that was added, or to its neighbour when one went.
                        tableFocus = when (op.type) {
                            "addRow" -> TableFocus(cell.table, cell.row + 1, cell.column)
                            "addColumn" -> TableFocus(cell.table, cell.row, cell.column + 1)
                            "deleteRow" -> TableFocus(cell.table, cell.row - 1, cell.column)
                            "deleteColumn" -> TableFocus(cell.table, cell.row, maxOf(0, cell.column - 1))
                            else -> null
                        }
                    },
                    onDeleteTable = { confirmTableDelete = cell.table },
                )
                // No keyboard in the body (the read view, the title, an item moved without a caret): a narrow bar with
                // only the two, and only while there is something to take back or to do again, as in Keep.
                else if (canUndo || canRedo) UndoBar(steps, fg)
            }
        }
    }
    }

    if (attachProblems.isNotEmpty()) {
        AttachProblemsDialog(attachProblems) { attachProblems = emptyList() }
    }

    if (labelsSheetOpen) {
        LabelAssignmentSheet(
            labels = Storage.getLabels(context),
            selectedLabels = labels.toSet(),
            onApply = { added, removed ->
                val uri = currentUri?.let { Uri.parse(it) }
                val result = if (uri == null) Result.success(LabelNames.applyChanges(labels.toList(), added, removed))
                else withContext(Dispatchers.IO) { Storage.updateLabels(context, uri, added, removed) }
                result.onSuccess { updated -> labels.clear(); labels.addAll(updated) }.map { Unit }
            },
            onDismiss = { labelsSheetOpen = false },
        )
    }

    if (showColorPicker) {
        ColorPickerDialog(
            current = color,
            dark = dark,
            onPick = { picked ->
                color = picked
                showColorPicker = false
                if (isExisting) applyMetaAsync(newColor = picked)
            },
            onDismiss = { showColorPicker = false },
        )
    }

    if (showLinkPicker) {
        LinkPickerDialog(
            onPick = { linkPath ->
                showLinkPicker = false
                val insert = "[[${linkPath}]]"
                val sel = bodyText.selection
                val start = sel.start.coerceIn(0, bodyText.text.length)
                val end = sel.end.coerceIn(0, bodyText.text.length)
                val newText = bodyText.text.substring(0, start) + insert + bodyText.text.substring(end)
                writeBody(TextFieldValue(
                    text = newText,
                    selection = androidx.compose.ui.text.TextRange(start + insert.length)
                ), EditKind.STEP)
                bodyEditing = true
            },
            onDismiss = { showLinkPicker = false },
        )
    }

    confirmTableDelete?.let { table ->
        AlertDialog(
            onDismissRequest = { confirmTableDelete = null },
            text = { Text(stringResource(R.string.table_delete_confirm)) },
            confirmButton = {
                TextButton(onClick = {
                    confirmTableDelete = null
                    editTable(table, FormatCore.TableOp("deleteTable"))
                    layoutKey++
                }) { Text(stringResource(R.string.table_delete)) }
            },
            dismissButton = {
                TextButton(onClick = { confirmTableDelete = null }) { Text(stringResource(R.string.action_cancel)) }
            },
        )
    }

    if (showMarkdownHelp) MarkdownHelpDialog(onDismiss = { showMarkdownHelp = false })
    folderCopy?.let { copy ->
        FolderPickerDialog(
            title = stringResource(if (copy) R.string.folder_picker_copy_title else R.string.folder_picker_move_title),
            hint = if (copy) null else stringResource(R.string.folder_picker_move_hint),
            folders = vaultFolders,
            onPick = { folder ->
                folderCopy = null
                val uri = currentUri ?: return@FolderPickerDialog
                scope.launch {
                    val parsedUri = Uri.parse(uri)
                    val res = withContext(Dispatchers.IO) {
                        Storage.noteWriteMutex.withLock { Storage.moveNoteToVaultFolder(context, parsedUri, folder, copy) }
                    }
                    val shownFolder = folder.ifEmpty { context.getString(R.string.folder_root_label) }
                    res.onSuccess {
                        Toast.makeText(context, context.getString(if (copy) R.string.toast_copied_to else R.string.toast_moved_to, shownFolder), Toast.LENGTH_SHORT).show()
                        if (!copy) {
                            // The note left JotDrop, so its reminder goes with it.
                            ReminderScheduler.cancel(context, parsedUri)
                            onClose()
                        }
                    }.onFailure { err ->
                        Toast.makeText(context, context.getString(R.string.toast_error, err.message ?: ""), Toast.LENGTH_LONG).show()
                    }
                }
            },
            onDismiss = { folderCopy = null },
        )
    }
    saveConflict?.let { (savedBody, retrySave) ->
        val mine = combineBodyAndEmbeds(joinHeadingTitle(titleText, bodyText.text, titleLevel), embedLines.toList())
        SaveConflictDialog(
            mine = mine,
            saved = savedBody,
            onKeepBoth = {
                saveConflict = null
                val uri = currentUri
                scope.launch {
                    // Zonder herinnering: anders gaan voor dezelfde notitie twee alarmen af.
                    val copy = FrontmatterWriter.apply(mine, NoteMeta(color = color, tags = tags.toList(), pinned = pinned), labels = labels.toList())
                    val res = withContext(Dispatchers.IO) {
                        Storage.noteWriteMutex.withLock { Storage.createNote(context, copy) }
                    }
                    res.onSuccess { (name, _) ->
                        Toast.makeText(context, context.getString(R.string.parked_copy_saved, name), Toast.LENGTH_LONG).show()
                        if (uri != null) loadInto(uri)
                    }.onFailure { err ->
                        Toast.makeText(context, context.getString(R.string.toast_error, err.message ?: ""), Toast.LENGTH_LONG).show()
                    }
                }
            },
            onUseMine = {
                saveConflict = null
                loadedBodyHash = editorBodyHash(savedBody)
                retrySave()
            },
            onUseSaved = {
                saveConflict = null
                currentUri?.let { uri -> scope.launch { loadInto(uri) } }
            },
            onDismiss = { saveConflict = null },
        )
    }

    if (showArchiveDialog) {
        ConfirmDialog(
            title = stringResource(R.string.archive_title),
            message = stringResource(R.string.archive_message),
            confirmLabel = stringResource(R.string.action_archive),
            onConfirm = {
                showArchiveDialog = false
                val uri = currentUri ?: return@ConfirmDialog
                scope.launch {
                    val parsedUri = Uri.parse(uri)
                    // Cancel reminder vóór de move: URI verandert na archiveren
                    // dus zonder cancel hier blijft de oude alarm als wees achter.
                    ReminderScheduler.cancel(context, parsedUri)
                    val res = withContext(Dispatchers.IO) {
                        Storage.archiveNote(context, parsedUri)
                    }
                    res.onSuccess {
                        Toast.makeText(context, R.string.toast_archived, Toast.LENGTH_SHORT).show()
                        onClose()
                    }.onFailure { err ->
                        Toast.makeText(context, context.getString(R.string.toast_error, err.message ?: ""), Toast.LENGTH_LONG).show()
                    }
                }
            },
            onDismiss = { showArchiveDialog = false },
        )
    }

    if (showDeleteDialog) {
        ConfirmDialog(
            title = stringResource(R.string.delete_title),
            message = stringResource(if (Storage.deletesForEveryone(initialUri)) R.string.shared_delete_message else R.string.delete_message),
            confirmLabel = stringResource(R.string.action_delete),
            onConfirm = {
                showDeleteDialog = false
                val uri = currentUri ?: return@ConfirmDialog
                scope.launch {
                    val parsedUri = Uri.parse(uri)
                    ReminderScheduler.cancel(context, parsedUri)
                    val res = withContext(Dispatchers.IO) {
                        Storage.noteWriteMutex.withLock { Storage.deleteOrTrashNote(context, parsedUri) }
                    }
                    res.onSuccess {
                        Toast.makeText(context, R.string.toast_deleted, Toast.LENGTH_SHORT).show()
                        onClose()
                    }.onFailure { err ->
                        Toast.makeText(context, context.getString(R.string.toast_error, err.message ?: ""), Toast.LENGTH_LONG).show()
                    }
                }
            },
            onDismiss = { showDeleteDialog = false },
        )
    }
    if (showParkedDiscard) {
        ConfirmDialog(
            title = stringResource(R.string.parked_discard_title),
            message = stringResource(R.string.parked_discard_message),
            confirmLabel = stringResource(R.string.parked_discard),
            onConfirm = {
                showParkedDiscard = false
                resolveParked(keepCopy = false)
            },
            onDismiss = { showParkedDiscard = false },
        )
    }
}

@OptIn(ExperimentalMaterial3Api::class, ExperimentalFoundationApi::class)
@Composable
private fun EditorBody(
    showReminder: Boolean = true,
    value: TextFieldValue,
    // The second value: from a text piece of a body with a table, how much of the body before and after that piece
    // must stay as it is (null: the whole body is one field).
    onValueChange: (TextFieldValue, kotlin.Pair<Int, Int>?) -> Unit,
    bodyEditing: Boolean,
    onEditBody: () -> Unit,
    onTick: (Int) -> Unit,
    onIndent: (String) -> Boolean = { false },
    items: ItemActions,
    formatted: Boolean = true,
    onBodyFocus: (Boolean) -> Unit = {},
    tableBackground: Color = Color.Transparent,
    layoutKey: Int = 0,
    tableFocus: TableFocus? = null,
    onTableFocusDone: () -> Unit = {},
    onTableEdit: (Int, FormatCore.TableOp) -> Unit = { _, _ -> },
    onCell: (TableCell?) -> Unit = {},
    onReplaceBody: (TextFieldValue) -> Unit = {},
    // Undo (false) or Redo (true) from a keyboard, and what one of them just changed: the note scrolls to it.
    onStep: (Boolean) -> Unit = {},
    reveal: EditApplied? = null,
    onRevealed: (EditApplied) -> Unit = {},
    title: String,
    onTitleChange: (String) -> Unit,
    embedItems: List<Pair<String, Uri>>,
    tags: List<String>,
    onAddTag: (String) -> Unit,
    onRemoveTag: (String) -> Unit,
    reminder: String?,
    repeat: String?,
    until: String?,
    limit: Int?,
    onReminderChange: (String?) -> Unit,
    onRepeatChange: (String?) -> Unit,
    onUntilChange: (String?) -> Unit,
    onLimitChange: (Int?) -> Unit,
    onClear: () -> Unit,
    onEditDrawing: (Uri) -> Unit,
    onRemoveEmbed: (String) -> Unit,
    foreground: Color,
) {
    val context = LocalContext.current
    var lightboxUri by remember { mutableStateOf<Uri?>(null) }
    val scrollState = rememberScrollState()
    // Compose kan in deze scrollkolom geen tekstveld meten dat hoger is dan
    // 2^18 px; een notitie van enkele MiB crashte de editor. Schatting is ruim:
    // elk teken telt als een volle em breed. De tekst blijft in de state, dus
    // tags/kleur/pin (updateNoteMeta) bewaren de body ongewijzigd.
    val density = LocalDensity.current
    val screenWidthDp = LocalConfiguration.current.screenWidthDp
    val bodyStyle = MaterialTheme.typography.bodyLarge
    val bodyLines = remember(value.text, screenWidthDp, density, bodyStyle) {
        with(density) {
            val charsPerLine = ((screenWidthDp - 64).dp.toPx() / bodyStyle.fontSize.toPx()).toInt().coerceAtLeast(1)
            value.text.lineSequence().sumOf { 1L + it.length / charsPerLine }
        }
    }
    val bodyTooTall = with(density) { bodyLines * bodyStyle.lineHeight.toPx() > 200_000f }
    // A task's line is as high as its row on the card: only that line, its paragraph says so (design checklists-77,
    // part 5). A note too long for that keeps its lines, and stays editable.
    val taskLine = if (with(density) { bodyLines * taskLineHeight.toPx() <= 200_000f }) taskLineHeight else androidx.compose.ui.unit.TextUnit.Unspecified
    // Where the note scrolls and what part of the screen shows it: a task that is dragged to its edge scrolls it.
    val gripScroll = remember(scrollState) { GripScroll(scrollState) }
    val preview = remember(value.text, foreground, bodyEditing, bodyTooTall) {
        if (bodyEditing || bodyTooTall) androidx.compose.ui.text.AnnotatedString("")
        else renderPreviewAnnotated(value.text, foreground, underlineLinks = false)
    }
    val previewLinks = preview.getStringAnnotations("URL", 0, preview.length)
    // A body with a table is shown in pieces (text, table, text) in the formatted view; without a table it stays one field.
    val pieceLayout = remember { PieceLayout() }
    var relayout by remember { mutableIntStateOf(0) }
    var focusText by remember { mutableStateOf<Int?>(null) }
    val pieces = if (formatted && !bodyTooTall && value.text.length <= FORMAT_RAW_ABOVE) {
        pieceLayout.update(value.text, Triple(layoutKey, relayout, formatted))
    } else emptyList()
    // A note that is only a table is one piece too: it is still a grid (with the strips above and below to type in).
    val split = pieces.size > 1 || pieces.singleOrNull()?.kind == "table"
    // Each piece's number among its own kind: the keys text-0, table-0, text-1 keep a field's focus when only its text changes.
    val ordinals = remember(pieces) {
        var texts = 0
        var tables = 0
        pieces.map { if (it.kind == "table") tables++ else texts++ }
    }
    val openLinkLabel = stringResource(R.string.action_open_link)
    fun openLink(url: String): Boolean {
        return try {
            context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
            true
        } catch (e: Exception) {
            Toast.makeText(context, context.getString(R.string.toast_error, e.message ?: ""), Toast.LENGTH_SHORT).show()
            false
        }
    }

    // Ctrl+Z, Ctrl+Y and Ctrl+Shift+Z from a keyboard are the note's own Undo and Redo (design checklists-77-v2, 4.4),
    // in the title, the body and a table cell. Taken before the field sees the key, so its own history never runs.
    val stepKeys = Modifier.onPreviewKeyEvent { event ->
        val redo = if (!event.isCtrlPressed || event.isAltPressed) null else when (event.key) {
            Key.Z -> event.isShiftPressed
            Key.Y -> if (event.isShiftPressed) null else true
            else -> null
        }
        if (redo != null && event.type == KeyEventType.KeyDown) onStep(redo)
        redo != null
    }
    // Undo and Redo show what they changed (4.1): the note scrolls to it when it is out of sight.
    val places = remember { RevealPlaces() }
    val titleView = remember { BringIntoViewRequester() }
    val revealScope = rememberCoroutineScope()
    LaunchedEffect(reveal) {
        val shown = reveal ?: return@LaunchedEffect
        // The text is laid out again first, and the field with the caret has seen that this change was no typing.
        repeat(2) { withFrameNanos {} }
        // The scrolling goes on after the note is told it is shown: typing right after Undo follows the caret again.
        revealScope.launch { if (shown.field == EditField.TITLE) titleView.bringIntoView() else places.show(shown.from, shown.to) }
        onRevealed(shown)
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(horizontal = 16.dp, vertical = 12.dp)
            .onGloballyPositioned {
                val bounds = it.boundsInRoot()
                gripScroll.top = bounds.top
                gripScroll.bottom = bounds.bottom
            }
            .verticalScroll(scrollState),
    ) {
        if (embedItems.isNotEmpty()) {
            // Eén enkele afbeelding krijgt een grote hero-weergave over de volle
            // breedte (max 260dp hoog, hele afbeelding zichtbaar) — pariteit met de
            // desktop-edit-modal. Bij meerdere embeds valt hij terug op de compacte
            // strip hieronder, anders eten de previews het halve scherm op.
            val soloImage = embedItems.singleOrNull()?.takeIf { !isAudioBasename(it.first) && !isDocumentBasename(it.first) }
            if (soloImage != null) {
                AsyncImage(
                    model = soloImage.second,
                    contentDescription = stringResource(R.string.action_open_image),
                    contentScale = ContentScale.Fit,
                    modifier = Modifier
                        .fillMaxWidth()
                        .heightIn(min = 140.dp, max = 260.dp)
                        .clip(RoundedCornerShape(8.dp))
                        .clickable { lightboxUri = soloImage.second },
                )
            } else {
                // Horizontaal scrollbare strip: audio-embeds krijgen een
                // play/pause-player; alle overige (image) types een thumbnail.
                val embedScroll = rememberScrollState()
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .horizontalScroll(embedScroll),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    for ((name, uri) in embedItems) {
                        if (isAudioBasename(name)) {
                            AudioPlayerCard(uri = uri, foreground = foreground)
                        } else if (isDocumentBasename(name)) {
                            // A PDF or document: a chip with its size that opens it, like the web app (Eric, 3 Nov), and a cross.
                            val size by produceState(Storage.attachmentSize(uri), uri) {
                                if (this.value < 0) this.value = withContext(Dispatchers.IO) { Storage.fileSize(context, uri) }
                            }
                            DocumentChip(name, foreground, size = size, onRemove = { onRemoveEmbed(name) }, modifier = Modifier.widthIn(max = 280.dp)) { openAttachment(context, uri, name) }
                        } else {
                            AsyncImage(
                                model = uri,
                                contentDescription = stringResource(R.string.action_open_image),
                                contentScale = ContentScale.Crop,
                                modifier = Modifier
                                    .height(140.dp)
                                    .aspectRatio(4f / 3f)
                                    .clip(RoundedCornerShape(8.dp))
                                    .clickable { lightboxUri = uri },
                            )
                        }
                    }
                }
            }
            Spacer(Modifier.height(8.dp))
        }
        TagEditor(
            tags = tags,
            onAdd = onAddTag,
            onRemove = onRemoveTag,
            foreground = foreground,
        )
        Spacer(Modifier.height(8.dp))
        if (showReminder) ReminderEditor(
            reminder = reminder,
            repeat = repeat,
            until = until,
            limit = limit,
            onReminderChange = onReminderChange,
            onRepeatChange = onRepeatChange,
            onUntilChange = onUntilChange,
            onLimitChange = onLimitChange,
            onClear = onClear,
            foreground = foreground,
        )
        Spacer(Modifier.height(12.dp))
        HorizontalDivider(color = foreground.copy(alpha = 0.15f))
        Spacer(Modifier.height(12.dp))
        TextField(
            value = title,
            onValueChange = onTitleChange,
            modifier = Modifier.fillMaxWidth().bringIntoViewRequester(titleView).then(stepKeys),
            // De titel is de eerste regel van de body; een titelwijziging herschrijft de onzichtbare tekst.
            enabled = !bodyTooTall,
            singleLine = true,
            placeholder = { Text(stringResource(R.string.editor_title_hint), color = foreground.copy(alpha = 0.5f)) },
            textStyle = MaterialTheme.typography.titleLarge,
            keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences),
            colors = TextFieldDefaults.colors(
                focusedContainerColor = Color.Transparent,
                unfocusedContainerColor = Color.Transparent,
                disabledContainerColor = Color.Transparent,
                focusedTextColor = foreground,
                unfocusedTextColor = foreground,
                disabledTextColor = foreground,
                cursorColor = foreground,
                focusedIndicatorColor = Color.Transparent,
                unfocusedIndicatorColor = Color.Transparent,
                disabledIndicatorColor = Color.Transparent,
            ),
        )
        // The preview is display-only; saving always uses the original TextFieldValue.
        if (bodyTooTall) {
            Text(
                stringResource(R.string.editor_body_too_large),
                color = foreground,
                style = MaterialTheme.typography.bodyLarge,
                modifier = Modifier.padding(16.dp),
            )
        } else if (!bodyEditing && previewLinks.isNotEmpty()) {
            TextButton(onClick = onEditBody) {
                Text(stringResource(R.string.editor_title_edit), color = foreground)
            }
            if (!split) PreviewText(preview, value.text, value.text, 0, 0, places, taskLine, formatted, onTick, items, gripScroll, foreground, openLinkLabel, ::openLink, onEditBody, Modifier.fillMaxWidth().heightIn(min = 200.dp).padding(16.dp))
            else Column(Modifier.fillMaxWidth().heightIn(min = 200.dp).padding(16.dp)) {
                // The same pieces as when editing: text as text with its links, a table as a grid; a tap edits.
                for ((i, piece) in pieces.withIndex()) key(piece.kind, ordinals[i]) {
                    val part = value.text.substring(piece.from, piece.to)
                    if (piece.kind == "table") TableGrid(
                        index = ordinals[i], source = part, foreground = foreground, background = tableBackground, editable = false,
                        focus = null, onFocusDone = {}, onEdit = {}, onCell = {}, onTap = onEditBody,
                        modifier = Modifier.padding(vertical = 8.dp).then(revealWhole(places, piece.from, piece.to)),
                    ) else {
                        val shown = remember(part, foreground) { renderPreviewAnnotated(part, foreground, underlineLinks = false) }
                        val linesAbove = value.text.substring(0, piece.from).count { it == '\n' }
                        PreviewText(shown, part, value.text, linesAbove, piece.from, places, taskLine, formatted, { onTick(linesAbove + it) }, items, gripScroll, foreground, openLinkLabel, ::openLink, onEditBody, Modifier.fillMaxWidth())
                    }
                }
            }
        } else if (!split) {
            BodyTextField(
                value = value,
                onValueChange = { onValueChange(it, null) },
                onTick = onTick,
                taskLine = taskLine,
                formatted = formatted,
                foreground = foreground,
                placeholder = true,
                onIndent = onIndent,
                whole = value.text,
                above = 0,
                offset = 0,
                places = places,
                revealing = reveal != null,
                scroll = gripScroll,
                items = items,
                modifier = Modifier
                    .fillMaxWidth()
                    .heightIn(min = 200.dp)
                    .onFocusChanged { onBodyFocus(it.isFocused) }
                    .then(stepKeys),
            )
        } else {
            // A body with a table: text fields and grids under each other (design 7.2). Each text field shows its own
            // part of the body; its changes go back as a change of the whole body, through the same input pipeline.
            val first = pieces.first()
            if (first.kind == "table") EdgeStrip(R.string.table_type_above, foreground) {
                val cr = if (value.text.substring(first.from, value.text.indexOf('\n', first.from).let { if (it < 0) first.to else it }).endsWith("\r")) "\r" else ""
                onReplaceBody(TextFieldValue("$cr\n$cr\n" + value.text, TextRange(0)))
                focusText = 0
            }
            for ((i, piece) in pieces.withIndex()) key(piece.kind, ordinals[i]) {
                val part = value.text.substring(piece.from, piece.to)
                if (piece.kind == "table") TableGrid(
                    index = ordinals[i], source = part, foreground = foreground, background = tableBackground, editable = true,
                    focus = tableFocus, onFocusDone = onTableFocusDone, onEdit = { op -> onTableEdit(ordinals[i], op) },
                    onCell = onCell, onTap = {},
                    modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp).then(revealWhole(places, piece.from, piece.to)).then(stepKeys),
                ) else {
                val prefix = piece.from
                val suffix = value.text.length - piece.to
                fun local(at: Int) = (at - prefix).coerceIn(0, part.length)
                val composition = value.composition?.takeIf { it.min >= piece.from && it.max <= piece.to }
                val pieceValue = TextFieldValue(part, TextRange(local(value.selection.start), local(value.selection.end)),
                    composition?.let { TextRange(it.start - prefix, it.end - prefix) })
                val whole = value.text
                var had by remember { mutableStateOf(false) }
                val requester = remember { FocusRequester() }
                val last = i == pieces.lastIndex
                LaunchedEffect(focusText) {
                    if (focusText == ordinals[i] || (focusText == Int.MAX_VALUE && last)) {
                        withFrameNanos {}
                        runCatching { requester.requestFocus() }
                        focusText = null
                    }
                }
                DisposableEffect(Unit) { onDispose { if (had) { pieceLayout.focused = -1; onBodyFocus(false) } } }
                BodyTextField(
                    value = pieceValue,
                    onValueChange = { field ->
                        val next = TextFieldValue(
                            whole.substring(0, prefix) + field.text + whole.substring(whole.length - suffix),
                            TextRange(field.selection.start + prefix, field.selection.end + prefix),
                            field.composition?.let { TextRange(it.start + prefix, it.end + prefix) },
                        )
                        onValueChange(next, prefix to suffix)
                    },
                    onTick = { line -> onTick(whole.substring(0, prefix).count { it == '\n' } + line) },
                    taskLine = taskLine,
                    formatted = true,
                    foreground = foreground,
                    placeholder = false,
                    onIndent = onIndent,
                    whole = whole,
                    above = remember(whole, prefix) { lineOf(whole, prefix) },
                    offset = prefix,
                    places = places,
                    revealing = reveal != null,
                    scroll = gripScroll,
                    items = items,
                    modifier = Modifier
                        .fillMaxWidth()
                        .then(if (last) Modifier.heightIn(min = 120.dp) else Modifier)
                        .then(stepKeys)
                        .focusRequester(requester)
                        .onFocusChanged { state ->
                            if (state.isFocused == had) return@onFocusChanged
                            had = state.isFocused
                            if (had) pieceLayout.focused = i
                            else if (pieceLayout.focused == i) { pieceLayout.focused = -1; relayout++ }
                            onBodyFocus(had)
                        },
                )
                }
            }
            val end = pieces.last()
            if (end.kind == "table") EdgeStrip(R.string.table_type_below, foreground) {
                val cr = if (value.text.substring(end.from, value.text.indexOf('\n', end.from).let { if (it < 0) end.to else it }).endsWith("\r")) "\r" else ""
                val text = value.text + "$cr\n$cr\n"
                onReplaceBody(TextFieldValue(text, TextRange(text.length)))
                focusText = Int.MAX_VALUE
            }
        }
    }
    lightboxUri?.let { uri ->
        val drawing = DrawingFormat.isDrawingName(Uri.decode(uri.lastPathSegment.orEmpty()).substringAfterLast('/'))
        ImageLightbox(uri = uri, onClose = { lightboxUri = null }, onEditDrawing = if (drawing) ({ onEditDrawing(uri) }) else null)
    }
}

// The height of a task's row on the card, as a line: room for the bigger box and for a finger.
private val taskLineHeight = 32.sp

// The room around the body's text inside its field (Material's own for a field without a label): the handles and the
// cross are laid over the text from outside the field and count from the same place.
private val bodyFieldPadding = 16.dp

/**
 * The body's text field: Material's TextField, built from its parts so the caret's place is known: typing on at the
 * bottom then scrolls the note, instead of going on under the keyboard and the formatting bar (Eric, 16 Nov). A body
 * with a table has one of these per text piece.
 */
@OptIn(ExperimentalMaterial3Api::class, ExperimentalFoundationApi::class)
@Composable
private fun BodyTextField(
    value: TextFieldValue,
    onValueChange: (TextFieldValue) -> Unit,
    onTick: (Int) -> Unit,
    taskLine: androidx.compose.ui.unit.TextUnit,
    formatted: Boolean,
    foreground: Color,
    placeholder: Boolean,
    onIndent: (String) -> Boolean,
    // The whole body and the number of its lines above this field (a body with a table has a field per piece of text),
    // where the note scrolls, and what the grips on a task ask of the editor.
    whole: String,
    above: Int,
    // Where this field's text starts in the body, where it tells how to show a place in its text, and whether Undo or
    // Redo is showing one now: then the note goes there, not to the caret.
    offset: Int,
    places: RevealPlaces,
    revealing: Boolean,
    scroll: GripScroll?,
    items: ItemActions,
    modifier: Modifier,
) {
    val bodyColors = TextFieldDefaults.colors(
        focusedContainerColor = Color.Transparent,
        unfocusedContainerColor = Color.Transparent,
        focusedTextColor = foreground,
        unfocusedTextColor = foreground,
        cursorColor = foreground,
        focusedIndicatorColor = Color.Transparent,
        unfocusedIndicatorColor = Color.Transparent,
    )
    // Lists stand in paragraphs of their own (FormatTransformation): a marker's width is measured as it is drawn, so a
    // line that wraps goes on right under its own words.
    val bodyStyle = LocalTextStyle.current
    val metrics = rememberListMetrics(bodyStyle, taskLine, boxStyle)
    // Formatting drawn over the source; the signs stay in the text but take no room (FormatTransformation).
    val transformation = remember(formatted, foreground, value.text, value.selection, metrics) {
        val pair = if (formatted) FormatCore.emptyPair(value.text, value.selection.min, value.selection.max) else null
        FormatTransformation(formatted, foreground, pair?.from ?: -1, pair?.to ?: -1, if (formatted) metrics else null)
    }
    val interaction = remember { MutableInteractionSource() }
    val focused by interaction.collectIsFocusedAsState()
    val caretView = remember { BringIntoViewRequester() }
    var bodyLayout by remember { mutableStateOf<TextLayoutResult?>(null) }
    // The boxes come out of the same pass that lays the text out for the field.
    val laid = transformation.laid(value.text)
    val boxes = laid.boxes
    // The cross stands on the task with the caret (design checklists-77, part 5): only while this field has the focus
    // and the caret, or all of a selection, is on one line.
    val caretLine = remember(value.text, value.selection, focused) {
        val next = value.text.indexOf('\n', value.selection.min)
        if (focused && (next < 0 || next >= value.selection.max)) lineOf(value.text, value.selection.min) else -1
    }
    // A tick leaves the note where the finger is; the caret comes back into view when it or the text changes again.
    // The same goes for an item that is dropped, and for what a screen reader does to a task: the caret can be elsewhere.
    var ticking by remember { mutableStateOf(false) }
    val gripActions = remember(items) {
        ItemActions(
            drop = { line, before, level -> items.drop(line, before, level).also { if (it) ticking = true } },
            delete = items.delete,
            act = { line, action -> items.act(line, action).also { if (it) ticking = true } },
            moveKey = items.moveKey,
        )
    }
    var afterTick by remember { mutableStateOf<kotlin.Pair<String, TextRange>?>(null) }
    val margin = with(LocalDensity.current) { 24.dp.toPx() }
    LaunchedEffect(value.text, value.selection, bodyLayout, focused) {
        val layout = bodyLayout
        val now = value.text to value.selection
        if (ticking || revealing) {
            ticking = false
            afterTick = now
        }
        if (!focused || layout == null || afterTick == now) return@LaunchedEffect
        val caret = layout.getCursorRect(value.selection.end.coerceIn(0, layout.layoutInput.text.length))
        caretView.bringIntoView(caret.copy(top = caret.top - margin, bottom = caret.bottom + margin))
    }
    RevealLines(places, offset, value.text.length, bodyLayout, caretView, margin)
    // Tab and Shift+Tab from a keyboard change the level of a list item (design checklists-77, 6.3), and Alt with the
    // arrow up or down moves the item with the caret (6.7). The key going up belongs to the key that went down.
    var tabTaken by remember { mutableStateOf(false) }
    var moveTaken by remember { mutableStateOf(false) }
    // The field and, over it, the handles and the cross: they lie next to the field, not in it, so a finger on them
    // is no touch of the text (see ListGrips).
    Box {
    BasicTextField(
        value = value,
        onValueChange = onValueChange,
        visualTransformation = transformation,
        modifier = modifier.onPreviewKeyEvent { event ->
            val arrow = event.key == Key.DirectionUp || event.key == Key.DirectionDown
            if (event.isCtrlPressed || event.isMetaPressed) false
            else if (arrow && event.isAltPressed && !event.isShiftPressed) {
                if (event.type == KeyEventType.KeyDown) items.moveKey(if (event.key == Key.DirectionUp) "up" else "down").also { moveTaken = it }
                else moveTaken.also { moveTaken = false }
            }
            else if (event.key != Key.Tab || event.isAltPressed) false
            else if (event.type == KeyEventType.KeyDown) onIndent(if (event.isShiftPressed) "out" else "in").also { tabTaken = it }
            else tabTaken.also { tabTaken = false }
        },
        textStyle = bodyStyle.merge(TextStyle(color = foreground)),
        cursorBrush = SolidColor(foreground),
        keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences),
        interactionSource = interaction,
        onTextLayout = { bodyLayout = it },
        decorationBox = { innerTextField ->
            TextFieldDefaults.DecorationBox(
                value = value.text,
                innerTextField = {
                    Box(Modifier.bringIntoViewRequester(caretView)) {
                        innerTextField()
                        Box(Modifier.matchParentSize()) {
                            TaskBoxes(boxes, bodyLayout, onAction = { line, action -> gripActions.act(above + line, action) }) { ticking = true; onTick(it) }
                        }
                    }
                },
                enabled = true,
                singleLine = false,
                visualTransformation = transformation,
                interactionSource = interaction,
                placeholder = if (placeholder) ({ Text(stringResource(R.string.editor_hint), color = foreground.copy(alpha = 0.5f)) }) else null,
                colors = bodyColors,
                contentPadding = PaddingValues(bodyFieldPadding),
            )
        },
    )
    // Over the text itself, which stands [bodyFieldPadding] inside the field.
    if (formatted) Box(Modifier.matchParentSize().padding(bodyFieldPadding)) {
        ListGrips(boxes, laid.starts, bodyLayout, metrics, whole, above, caretLine, foreground, scroll, gripActions) { ticking = true; onTick(it) }
    }
    }
}

/**
 * A place to tap on each box, laid over the text: 40 dp wide, reaching into the margin, as high as the line. It takes
 * the tap before the text field does, so a tick places no caret and opens no keyboard.
 *
 * Only the boxes near what is on the screen get one (design checklists-77, part 5): the screen's height is cut in two,
 * and the boxes from a screen above the half in view to a screen below it count. A list of 300 tasks is then some 60
 * places, not 300.
 *
 * A screen reader cannot drag a handle, so the box carries the same moves as actions (design checklists-77, 6.7): Move
 * up, Move down, Indent, Outdent and Delete item, through [onAction] with "up", "down", "in", "out" or "delete".
 */
@Composable
private fun TaskBoxes(boxes: List<TaskBox>, layout: TextLayoutResult?, onAction: (Int, String) -> Unit, onTick: (Int) -> Unit) {
    if (layout == null || boxes.isEmpty()) return
    val density = LocalDensity.current
    val actionNames = listOf(
        "up" to stringResource(R.string.list_move_up),
        "down" to stringResource(R.string.list_move_down),
        "in" to stringResource(R.string.format_indent),
        "out" to stringResource(R.string.format_outdent),
        "delete" to stringResource(R.string.list_delete_item),
    )
    val half = with(density) { LocalConfiguration.current.screenHeightDp.dp.toPx() } / 2
    var band by remember { mutableIntStateOf(0) }
    // Every place is counted from the left of the text as it is laid out, so this layer is never mirrored: on a phone
    // that reads right to left the places stood at the other side of the screen, far from their boxes (seen 22 Nov).
    CompositionLocalProvider(androidx.compose.ui.platform.LocalLayoutDirection provides androidx.compose.ui.unit.LayoutDirection.Ltr) {
    // Unbounded: a short line makes the text narrower than a finger.
    Box(
        Modifier
            .fillMaxSize()
            .onGloballyPositioned { band = kotlin.math.floor(-it.positionInWindow().y / half).toInt() }
            .wrapContentSize(Alignment.TopStart, unbounded = true),
    ) {
        val from = (band - 2) * half
        val to = (band + 5) * half
        for (box in boxes) {
            // The layout can be one frame behind the text.
            if (box.at >= layout.layoutInput.text.length) continue
            val line = layout.getLineForOffset(box.at)
            val top = layout.getLineTop(line)
            if (top < from || top > to) continue
            key(box.line) {
                val left = boxReachLeft(layout, box.at, density)
                Box(
                    Modifier
                        .offset { IntOffset(left.toInt(), top.toInt()) }
                        .size(BOX_REACH, with(density) { (layout.getLineBottom(line) - top).toDp() })
                        .toggleable(value = box.checked, role = Role.Checkbox, onValueChange = { onTick(box.line) })
                        .semantics {
                            contentDescription = box.label
                            customActions = actionNames.map { (action, name) -> CustomAccessibilityAction(name) { onAction(box.line, action); true } }
                        },
                )
            }
        }
    }
    }
}

/**
 * The measure the lists of a note are placed with (FormatTransformation): a marker's width is measured as it is drawn,
 * with [box] the style of a task's box, so a line that wraps goes on right under its own words.
 */
@Composable
private fun rememberListMetrics(style: TextStyle, taskLine: androidx.compose.ui.unit.TextUnit, box: androidx.compose.ui.text.SpanStyle): ListMetrics {
    val measurer = rememberTextMeasurer()
    val density = LocalDensity.current
    return remember(measurer, density, style, taskLine, box) {
        ListMetrics(taskLine, toPx = { with(density) { it.sp.toPx() } }, toSp = { with(density) { it.toSp() } }) { marker ->
            val probe = androidx.compose.ui.text.AnnotatedString(
                marker + "a",
                spanStyles = if (marker.startsWith('☐') || marker.startsWith('☑')) listOf(androidx.compose.ui.text.AnnotatedString.Range(box, 0, 1)) else emptyList(),
            )
            measurer.measure(probe, style, softWrap = false).getHorizontalPosition(marker.length, true)
        }
    }
}

// The box of a task in the read view, as renderPreviewAnnotated draws it: bold, and one and a half times the text.
private val previewBoxStyle = androidx.compose.ui.text.SpanStyle(fontWeight = FontWeight.Bold, fontSize = 1.5.em)

/**
 * The read view of a note with links: the links open, a box ticks, a tap anywhere else edits the note. With [lists]
 * (the Markdown switch is off) its lists stand as in the open note, and a task has its handle here too (design
 * checklists-77, part 5); the cross is not here, as there is no caret. [source] is the text it shows, [whole] the
 * whole body, [above] the number of its lines above [source] and [offset] where [source] starts in it.
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun PreviewText(
    preview: androidx.compose.ui.text.AnnotatedString,
    source: String,
    whole: String,
    above: Int,
    offset: Int,
    places: RevealPlaces,
    taskLine: androidx.compose.ui.unit.TextUnit,
    lists: Boolean,
    onTick: (Int) -> Unit,
    items: ItemActions,
    scroll: GripScroll?,
    foreground: Color,
    openLinkLabel: String,
    openLink: (String) -> Boolean,
    onEditBody: () -> Unit,
    modifier: Modifier,
) {
    val links = preview.getStringAnnotations("URL", 0, preview.length)
    var previewLayout by remember { mutableStateOf<TextLayoutResult?>(null) }
    // The read view drops signs, so a box stands elsewhere in it; it is on the same line.
    val boxes = remember(preview, source) {
        val drawn = preview.getStringAnnotations("CHECKLIST", 0, preview.length)
            .associate { mark -> preview.text.substring(0, mark.start).count { it == '\n' } to mark.start }
        taskBoxes(source).mapNotNull { box -> drawn[box.line]?.let { box.copy(at = it) } }
    }
    val style = MaterialTheme.typography.bodyLarge
    val metrics = rememberListMetrics(style, taskLine, previewBoxStyle)
    val laid = remember(preview, source, metrics, lists) { previewInParagraphs(preview, source, if (lists) metrics else null) }
    val textView = remember { BringIntoViewRequester() }
    // The read view drops signs, so a place stands elsewhere in it; it is on the same line.
    RevealLines(places, offset, source.length, previewLayout, textView, with(LocalDensity.current) { 24.dp.toPx() }) { at -> laid.starts.getOrElse(lineOf(source, at)) { 0 } }
    Box(modifier, propagateMinConstraints = true) {
        ClickableText(
            text = laid.text,
            style = style.copy(color = foreground),
            onTextLayout = { previewLayout = it },
            modifier = Modifier.fillMaxWidth().bringIntoViewRequester(textView).semantics {
                customActions = links.map { link ->
                    CustomAccessibilityAction(
                        "$openLinkLabel: ${preview.subSequence(link.start, link.end).text} (${link.item})",
                    ) { openLink(link.item) }
                }
            },
            onClick = { offset ->
                val url = preview.getStringAnnotations("URL", offset, offset).firstOrNull()?.item
                if (url == null) {
                    onEditBody()
                } else {
                    openLink(url)
                }
            },
        )
        if (lists) Box(Modifier.matchParentSize()) { ListGrips(boxes, laid.starts, previewLayout, metrics, whole, above, -1, foreground, scroll, items, onTick) }
        Box(Modifier.matchParentSize()) { TaskBoxes(boxes, previewLayout, onAction = { line, action -> items.act(above + line, action) }, onTick = onTick) }
    }
}

/**
 * The parts of the body as it is shown (a text field, the read view, a table), for showing a place in its text: Undo
 * and Redo scroll the note to what they changed (design checklists-77-v2, 4.1). Each part says whether the place is
 * its own, and brings it into view.
 */
internal class RevealPlaces {
    private val parts = mutableListOf<suspend (Int, Int) -> Boolean>()
    fun add(part: suspend (Int, Int) -> Boolean) { parts += part }
    fun remove(part: suspend (Int, Int) -> Boolean) { parts -= part }
    /** Shows the body from [from] to [to]: the part that holds [from] does it. */
    suspend fun show(from: Int, to: Int) { for (part in parts.toList()) if (part(from, to)) return }
}

/**
 * A text of the body among the [places]: [length] characters that start at [offset] in the body, laid out as [layout].
 * A place in it is shown by the lines that hold it, with [margin] around them. [shownAt] gives where a place of the
 * text stands in the text as it is laid out (the read view drops signs).
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun RevealLines(places: RevealPlaces, offset: Int, length: Int, layout: TextLayoutResult?, view: BringIntoViewRequester, margin: Float, shownAt: (Int) -> Int = { it }) {
    val current by rememberUpdatedState(Triple(offset, length, layout))
    val shown by rememberUpdatedState(shownAt)
    DisposableEffect(places) {
        val part: suspend (Int, Int) -> Boolean = part@{ from, to ->
            val (start, size, laid) = current
            if (from < start || from > start + size) return@part false
            if (laid != null) {
                val end = laid.layoutInput.text.length
                val first = laid.getLineForOffset(shown(from - start).coerceIn(0, end))
                val last = laid.getLineForOffset(shown((to - start).coerceIn(0, size)).coerceIn(0, end))
                view.bringIntoView(Rect(0f, laid.getLineTop(first) - margin, 1f, laid.getLineBottom(maxOf(first, last)) + margin))
            }
            true
        }
        places.add(part)
        onDispose { places.remove(part) }
    }
}

/** A table of the body, from [from] to [to], among the [places]: a place in it is shown by the whole table. */
@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun revealWhole(places: RevealPlaces, from: Int, to: Int): Modifier {
    val view = remember { BringIntoViewRequester() }
    val range by rememberUpdatedState(from..to)
    DisposableEffect(places) {
        val part: suspend (Int, Int) -> Boolean = { at, _ -> (at in range).also { if (it) view.bringIntoView() } }
        places.add(part)
        onDispose { places.remove(part) }
    }
    return Modifier.bringIntoViewRequester(view)
}

/** A strip to type above or below a table at the very start or end of the note (design 5.4). */
@Composable
private fun EdgeStrip(label: Int, foreground: Color, onClick: () -> Unit) {
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = 44.dp)
            .clickable(role = Role.Button, onClick = onClick)
            .padding(horizontal = 16.dp),
        contentAlignment = Alignment.CenterStart,
    ) {
        Text("+ " + stringResource(label), color = foreground.copy(alpha = 0.65f), style = MaterialTheme.typography.bodyMedium)
    }
}

/** What the strip above the formatting bar says. A new one for each time, so the same words count again. */
internal class EditorNotice(val message: String)

/**
 * The strip above the formatting bar: what a list action took away when that was more than could be seen (design
 * checklists-77-v2, 4.5). It has no Undo: that is always in sight in the bar under it. It stays 4 seconds, or as long
 * as the phone's setting for people who need more time asks. A swipe over it to either side takes it away, and so does
 * its cross, and the next change. TalkBack reads the strip when it comes.
 */
@Composable
private fun NoticeStrip(notice: EditorNotice, foreground: Color, onGone: () -> Unit) {
    val accessibility = LocalAccessibilityManager.current
    val gone by rememberUpdatedState(onGone)
    LaunchedEffect(notice) {
        delay(accessibility?.calculateRecommendedTimeoutMillis(4_000L, containsText = true, containsControls = true) ?: 4_000L)
        gone()
    }
    // How far the finger has pushed the strip aside.
    var pushed by remember(notice) { mutableFloatStateOf(0f) }
    Column(Modifier.fillMaxWidth()) {
        HorizontalDivider(color = foreground.copy(alpha = 0.15f))
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .offset { IntOffset(pushed.toInt(), 0) }
                .pointerInput(notice) {
                    detectHorizontalDragGestures(
                        onDragEnd = { if (kotlin.math.abs(pushed) > 72.dp.toPx()) gone() else pushed = 0f },
                        onDragCancel = { pushed = 0f },
                    ) { change, amount ->
                        change.consume()
                        pushed += amount
                    }
                }
                .background(foreground.copy(alpha = 0.06f))
                .heightIn(min = 48.dp)
                .padding(start = 16.dp, end = 4.dp)
                .semantics { liveRegion = LiveRegionMode.Polite },
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(notice.message, color = foreground, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.weight(1f).padding(vertical = 8.dp))
            val dismiss = stringResource(R.string.notice_dismiss)
            Box(
                modifier = Modifier
                    .size(48.dp)
                    .clip(RoundedCornerShape(8.dp))
                    .clickable(role = Role.Button) { gone() }
                    .semantics { contentDescription = dismiss },
                contentAlignment = Alignment.Center,
            ) {
                Icon(Icons.Filled.Close, contentDescription = null, tint = foreground)
            }
        }
    }
}

/**
 * Kop met vorige/volgende-knoppen en een "3 / 12"-positieteller boven de editor.
 * Alleen zichtbaar wanneer er een kaartvolgorde is meegegeven (≥2 notities).
 * De knoppen maken de navigatie ontdekbaar; disabled-staat aan de uiteinden
 * via zowel enabled-attribuut als lagere alpha (niet alleen kleur).
 */
@Composable
private fun EditorNavHeader(
    index: Int,
    total: Int,
    foreground: Color,
    onPrev: () -> Unit,
    onNext: () -> Unit,
) {
    val hasPrev = index > 0
    val hasNext = index < total - 1
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        IconButton(onClick = onPrev, enabled = hasPrev) {
            Icon(
                Icons.AutoMirrored.Filled.KeyboardArrowLeft,
                contentDescription = stringResource(R.string.nav_prev_note),
                tint = foreground.copy(alpha = if (hasPrev) 1f else 0.35f),
            )
        }
        Text(
            text = "${index + 1} / $total",
            modifier = Modifier.weight(1f),
            textAlign = TextAlign.Center,
            style = MaterialTheme.typography.labelLarge,
            color = foreground.copy(alpha = 0.8f),
        )
        IconButton(onClick = onNext, enabled = hasNext) {
            Icon(
                Icons.AutoMirrored.Filled.KeyboardArrowRight,
                contentDescription = stringResource(R.string.nav_next_note),
                tint = foreground.copy(alpha = if (hasNext) 1f else 0.35f),
            )
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class, androidx.compose.foundation.layout.ExperimentalLayoutApi::class)
@Composable
private fun TagEditor(
    tags: List<String>,
    onAdd: (String) -> Unit,
    onRemove: (String) -> Unit,
    foreground: Color,
) {
    var input by remember { mutableStateOf("") }
    var refocusAfterCommit by remember { mutableStateOf(false) }
    val focusRequester = remember { FocusRequester() }

    LaunchedEffect(tags, refocusAfterCommit) {
        if (refocusAfterCommit) {
            focusRequester.requestFocus()
            refocusAfterCommit = false
        }
    }

    fun commit() {
        val v = input.removePrefix("#").trim()
        if (v.isNotEmpty()) {
            onAdd(v)
            refocusAfterCommit = true
        }
        input = ""
    }

    fun commitSeparated(value: String) {
        val values = value
            .split(Regex("[\\s,]+"))
            .map { it.removePrefix("#").trim() }
            .filter { it.isNotEmpty() }
        for (v in values) {
            onAdd(v)
            refocusAfterCommit = true
        }
        input = ""
    }

    androidx.compose.foundation.layout.FlowRow(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        for (tag in tags) {
            EditorTagChip(tag, foreground = foreground, onRemove = { onRemove(tag) })
        }
        BasicTextField(
            value = input,
            onValueChange = { value ->
                if (value.any { it == '\n' || it == ',' || it == ' ' || it == '\t' }) {
                    commitSeparated(value)
                } else {
                    input = value
                }
            },
            modifier = Modifier
                .focusRequester(focusRequester)
                .defaultMinSize(minWidth = 100.dp)
                .padding(vertical = 6.dp),
            singleLine = true,
            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
            keyboardActions = KeyboardActions(onDone = { commit() }),
            textStyle = MaterialTheme.typography.bodyMedium.copy(color = foreground),
            cursorBrush = androidx.compose.ui.graphics.SolidColor(foreground),
            decorationBox = { innerTextField ->
                Box(contentAlignment = Alignment.CenterStart) {
                    if (input.isEmpty()) {
                        Text(
                            text = stringResource(R.string.tag_placeholder),
                            style = MaterialTheme.typography.bodyMedium,
                            color = foreground.copy(alpha = 0.5f),
                        )
                    }
                    innerTextField()
                }
            },
        )
    }
}

@Composable
private fun EditorTagChip(tag: String, foreground: Color, onRemove: () -> Unit) {
    Surface(
        color = foreground.copy(alpha = 0.12f),
        contentColor = foreground,
        shape = RoundedCornerShape(16.dp),
    ) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier.padding(horizontal = 8.dp, vertical = 2.dp),
        ) {
            Text(
                "#$tag",
                style = MaterialTheme.typography.labelMedium,
                color = foreground,
            )
            Spacer(Modifier.width(4.dp))
            Icon(
                Icons.Filled.Close,
                contentDescription = stringResource(R.string.action_remove_tag),
                tint = foreground.copy(alpha = 0.7f),
                modifier = Modifier
                    .size(14.dp)
                    .clickable(onClick = onRemove),
            )
        }
    }
}

/** Also used from the note list; [current] is null when the selected notes have different colors. */
@Composable
internal fun ColorPickerDialog(
    current: NoteColor?,
    dark: Boolean,
    onPick: (NoteColor) -> Unit,
    onDismiss: () -> Unit,
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.color_picker_title)) },
        text = {
            Column {
                val rows = NoteColor.entries.chunked(6)
                for (row in rows) {
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.padding(vertical = 4.dp)) {
                        for (c in row) {
                            ColorSwatch(c = c, isActive = c == current, dark = dark, onClick = { onPick(c) })
                        }
                    }
                }
                if (current != null) {
                    Spacer(Modifier.height(8.dp))
                    Text(
                        text = stringResource(R.string.color_label, stringResource(current.labelRes)),
                        style = MaterialTheme.typography.bodySmall,
                    )
                }
            }
        },
        confirmButton = {
            TextButton(onClick = onDismiss) { Text(stringResource(R.string.action_close)) }
        },
    )
}

@Composable
private fun ColorSwatch(c: NoteColor, isActive: Boolean, dark: Boolean, onClick: () -> Unit) {
    val palette = if (dark) Palette.dark else Palette.light
    val bg = palette[c] ?: palette[NoteColor.DEFAULT]!!
    val checkColor = if (dark) Color.White else Color.Black
    Box(
        modifier = Modifier
            .size(36.dp)
            .clip(CircleShape)
            .background(bg)
            .border(
                width = if (isActive) 3.dp else 1.dp,
                color = if (isActive) MaterialTheme.colorScheme.primary else Color.Gray.copy(alpha = 0.4f),
                shape = CircleShape,
            )
            .clickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        if (isActive) {
            Icon(
                Icons.Filled.Check,
                contentDescription = stringResource(c.labelRes),
                tint = checkColor,
                modifier = Modifier.size(20.dp),
            )
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun LinkPickerDialog(onPick: (String) -> Unit, onDismiss: () -> Unit) {
    val context = LocalContext.current
    var query by remember { mutableStateOf("") }
    var allFiles by remember { mutableStateOf<List<VaultMarkdownFile>>(emptyList()) }
    var loading by remember { mutableStateOf(true) }

    LaunchedEffect(Unit) {
        val result = withContext(Dispatchers.IO) { Storage.listAllVaultMarkdownFiles(context) }
        allFiles = result.getOrDefault(emptyList())
        loading = false
    }

    val q = query.trim().lowercase()
    val filtered = remember(query, allFiles) {
        if (q.isEmpty()) allFiles.take(50)
        else allFiles.filter {
            it.basename.lowercase().contains(q) || it.relativePath.lowercase().contains(q)
        }.take(50)
    }
    val basenameCounts = remember(allFiles) {
        allFiles.groupingBy { it.basename.lowercase() }.eachCount()
    }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.link_picker_title)) },
        text = {
            Column {
                OutlinedTextField(
                    value = query,
                    onValueChange = { query = it },
                    placeholder = { Text(stringResource(R.string.link_picker_placeholder)) },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
                Spacer(Modifier.height(8.dp))
                if (loading) {
                    Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
                        CircularProgressIndicator()
                    }
                } else if (filtered.isEmpty()) {
                    Text(stringResource(R.string.link_picker_empty))
                } else {
                    LazyColumn(modifier = Modifier.height(320.dp)) {
                        items(filtered, key = { it.uri.toString() }) { file ->
                            LinkPickerRow(file = file) {
                                val linkPath = if ((basenameCounts[file.basename.lowercase()] ?: 0) > 1) {
                                    file.relativePath
                                } else {
                                    file.basename
                                }
                                onPick(linkPath)
                            }
                        }
                    }
                }
            }
        },
        confirmButton = {
            TextButton(onClick = onDismiss) { Text(stringResource(R.string.action_cancel)) }
        },
    )
}

@Composable
private fun LinkPickerRow(file: VaultMarkdownFile, onClick: () -> Unit) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(vertical = 8.dp, horizontal = 4.dp),
    ) {
        Text(file.basename, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold)
        Text(
            file.relativePath,
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
    HorizontalDivider(color = MaterialTheme.colorScheme.outline.copy(alpha = 0.15f))
}

/** Toont beide versies naast elkaar; niets gaat verloren tot de gebruiker kiest. */
@Composable
private fun SaveConflictDialog(
    mine: String,
    saved: String,
    onKeepBoth: () -> Unit,
    onUseMine: () -> Unit,
    onUseSaved: () -> Unit,
    onDismiss: () -> Unit,
) {
    @Composable
    fun Version(label: String, text: String) {
        Text(label, style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.SemiBold)
        Text(
            text = text,
            style = MaterialTheme.typography.bodySmall,
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(max = 140.dp)
                .border(1.dp, MaterialTheme.colorScheme.outline.copy(alpha = 0.4f), RoundedCornerShape(8.dp))
                .padding(8.dp)
                .verticalScroll(rememberScrollState()),
        )
    }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.save_conflict_title)) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(stringResource(R.string.save_conflict_message))
                Version(stringResource(R.string.save_conflict_mine), mine)
                Version(stringResource(R.string.save_conflict_saved), saved)
            }
        },
        confirmButton = {
            Column(horizontalAlignment = Alignment.End) {
                TextButton(onClick = onKeepBoth) { Text(stringResource(R.string.save_conflict_keep_both)) }
                TextButton(onClick = onUseMine) { Text(stringResource(R.string.save_conflict_use_mine)) }
                TextButton(onClick = onUseSaved) { Text(stringResource(R.string.save_conflict_use_saved)) }
                TextButton(onClick = onDismiss) { Text(stringResource(R.string.action_cancel)) }
            }
        },
    )
}

@Composable
private fun ConfirmDialog(
    title: String,
    message: String,
    confirmLabel: String,
    onConfirm: () -> Unit,
    onDismiss: () -> Unit,
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(title) },
        text = { Text(message) },
        confirmButton = { TextButton(onClick = onConfirm) { Text(confirmLabel) } },
        dismissButton = { TextButton(onClick = onDismiss) { Text(stringResource(R.string.action_cancel)) } },
    )
}

private fun attemptSaveAndClose(
    scope: CoroutineScope,
    context: Context,
    bodyText: String,
    title: String,
    titleLevel: Int = 1,
    embedLines: List<String>,
    currentUri: String?,
    expectedBodyHash: String?,
    color: NoteColor,
    pinned: Boolean,
    tags: List<String>,
    labels: List<String>,
    reminder: String?,
    reminderRepeat: String?,
    reminderUntil: String?,
    reminderLimit: Int?,
    reminderDone: Int,
    isDirty: Boolean,
    onSavingChange: (Boolean) -> Unit,
    onSaved: (Uri?) -> Unit,
    onError: (String) -> Unit,
    onConflict: (currentBody: String) -> Unit,
    closeWhenClean: Boolean,
    onClose: () -> Unit,
) {
    val meta = NoteMeta(
        color = color, tags = tags, pinned = pinned,
        reminder = reminder, reminderRepeat = reminderRepeat,
        reminderUntil = reminderUntil, reminderLimit = reminderLimit, reminderDone = reminderDone,
    )
    if (!isDirty && currentUri != null) {
        // Metadata is bij bestaande notities al onmiddellijk gesynct; alleen sluiten.
        if (closeWhenClean) onClose()
        return
    }
    // Hashtags die de gebruiker typt of die al in de notitie stonden blijven
    // staan: dat zijn bewuste Obsidian-tags (issue #16). Alleen gedeelde inhoud
    // wordt geneutraliseerd (ShareActivity, PreviewWorker).
    // Titel terug als leidende `# kop`; lege titel → geen kop, dan leidt de
    // kaart 'm af uit de body (ongewijzigd fallback-gedrag).
    val merged = joinHeadingTitle(title, bodyText, titleLevel)
    val combinedBody = combineBodyAndEmbeds(merged, embedLines)
    if (combinedBody.isBlank()) {
        if (currentUri == null) {
            if (closeWhenClean) onClose()
        } else {
            onError(context.getString(R.string.error_empty))
        }
        return
    }
    onSavingChange(true)
    scope.launch {
        val result: Result<Uri?> = withContext(Dispatchers.IO) {
            // Onder de schrijf-mutex zodat deze read-modify-write niet kan
            // verweven met een nog lopende meta-update of PreviewWorker-write.
            Storage.noteWriteMutex.withLock {
                if (currentUri != null) {
                    // Body wijzigt — herschrijf bestand met behoud van frontmatter.
                    val rawCurrent = Storage.readNote(context, Uri.parse(currentUri))
                        .getOrElse { return@withContext Result.failure(it) }
                    val parsed = FrontmatterParser.parse(rawCurrent)
                    if (expectedBodyHash == null || editorBodyHash(parsed.body) != expectedBodyHash) {
                        return@withContext Result.failure(NoteChangedException(parsed.body.removePrefix("\n")))
                    }
                    val fmBlock = parsed.frontmatter
                    val newRaw = if (fmBlock.isEmpty()) combinedBody else fmBlock + combinedBody
                    // Pas eerst meta toe (geeft consistente frontmatter), dan write.
                    Storage.updateNote(context, Uri.parse(currentUri), FrontmatterWriter.apply(newRaw, meta)).map { null }
                } else {
                    // Nieuwe notitie: body + meta in één keer wegschrijven.
                    val combined = FrontmatterWriter.apply(combinedBody, meta, labels = labels)
                    Storage.createNote(context, combined).map { it.second }
                }
            }
        }
        onSavingChange(false)
        result.onSuccess { newUri -> onSaved(newUri) }
            .onFailure { err ->
                if (err is NoteChangedException) onConflict(err.currentBody)
                else onError(context.getString(R.string.toast_error, err.message ?: ""))
            }
    }
}

/** Opslaan geweigerd: de notitie is gewijzigd sinds de editor haar opende. */
internal class NoteChangedException(val currentBody: String) :
    IllegalStateException("This note changed since it was opened.")

/**
 * De body zoals de editor hem vergelijkt voor opslaan. Pin, kleur, tags en
 * herinnering schrijven direct de frontmatter en laten daarbij de witregel na
 * de frontmatter vallen; dat is geen wijziging van de notitie zelf.
 */
internal fun editorBodyHash(body: String): String =
    CloudSyncEngine.hash(body.trimStart('\r', '\n').toByteArray(Charsets.UTF_8))

/**
 * Scheidt een body in twee delen: tekst (zonder embed-only regels) en de
 * embed-regels los. Behoudt blank-line-structuur in de tekst, behalve een
 * eventuele dubbele newline die ontstaat door het wegfilteren van een embed.
 */
private val EMBED_LINE_REGEX = Regex("^\\s*!\\[\\[[^\\]]+]]\\s*$")

/**
 * Splitst een body in een expliciete titel (de eerste `# kop`-regel) en de
 * rest. Geen kop → lege titel en de hele tekst blijft body; de kaart leidt dan
 * zoals vanouds een titel af uit de eerste woorden van de body.
 */
internal fun splitHeadingTitle(text: String): Triple<String, String, Int> {
    val lines = text.split("\n")
    var i = 0
    while (i < lines.size && lines[i].isBlank()) i++
    val heading = if (i < lines.size) Regex("^(#{1,6})\\s+(.*\\S)\\s*$").find(lines[i]) else null
    if (heading == null) return Triple("", text, 1)
    val body = lines.drop(i + 1).joinToString("\n").trimStart('\n')
    return Triple(heading.groupValues[2].trim(), body, heading.groupValues[1].length)
}

/**
 * Voegt een expliciete titel en body weer samen. Lege titel → alleen body
 * (geen kop), zodat de kaart 'm automatisch afleidt. [level] bewaart de
 * oorspronkelijke kop-diepte: een `## titel` mag bij opslaan niet stilletjes
 * degraderen naar `#`.
 */
internal fun joinHeadingTitle(title: String, body: String, level: Int = 1): String {
    val t = title.trim()
    val b = body.trim('\n')
    if (t.isEmpty()) return b
    val marker = "#".repeat(level.coerceIn(1, 6))
    return if (b.isEmpty()) "$marker $t" else "$marker $t\n\n$b"
}

internal fun splitBodyAndEmbeds(body: String): Pair<String, List<String>> {
    val embeds = mutableListOf<String>()
    val kept = mutableListOf<String>()
    for (line in body.lines()) {
        if (EMBED_LINE_REGEX.matches(line)) {
            embeds.add(line.trim())
        } else {
            kept.add(line)
        }
    }
    // Vouw opeenvolgende lege regels samen en strip leading/trailing blanks zodat
    // er geen dubbele witregels achterblijven na het wegfilteren van een embed.
    val cleaned = mutableListOf<String>()
    var prevBlank = false
    for (line in kept) {
        val blank = line.isBlank()
        if (blank && prevBlank) continue
        cleaned.add(line)
        prevBlank = blank
    }
    while (cleaned.isNotEmpty() && cleaned.first().isBlank()) cleaned.removeAt(0)
    while (cleaned.isNotEmpty() && cleaned.last().isBlank()) cleaned.removeAt(cleaned.size - 1)
    return cleaned.joinToString("\n") to embeds
}

internal fun combineBodyAndEmbeds(bodyText: String, embedLines: List<String>): String {
    if (embedLines.isEmpty()) return bodyText
    val body = bodyText.trimEnd('\n')
    return if (body.isEmpty()) embedLines.joinToString("\n")
    else body + "\n\n" + embedLines.joinToString("\n")
}

internal fun extractEmbedBasename(embedLine: String): String? {
    val m = Regex("!\\[\\[([^\\]]+)]]").find(embedLine) ?: return null
    return m.groupValues[1].trim().substringBefore("|").trim().takeIf { it.isNotEmpty() }
}

// "webm" hoort erbij: desktop-voicememo's (plugin, MediaRecorder opus/webm)
// werden anders als kapotte afbeelding gerenderd i.p.v. als audio-player.
private val AUDIO_EXTENSIONS = setOf("m4a", "mp3", "wav", "ogg", "aac", "flac", "3gp", "amr", "webm")

internal fun isAudioBasename(name: String): Boolean {
    val ext = name.substringAfterLast('.', "").lowercase()
    return ext in AUDIO_EXTENSIONS
}

// Same image extensions as Storage.looksLikeImage; anything else that is not audio is a document (a PDF, a file from a mail).
private val IMAGE_EXTENSIONS = setOf("jpg", "jpeg", "png", "gif", "webp", "bmp", "svg")

internal fun isDocumentBasename(name: String): Boolean {
    val ext = name.substringAfterLast('.', "").lowercase()
    return ext !in IMAGE_EXTENSIONS && ext !in AUDIO_EXTENSIONS
}

/**
 * Inline audio-player voor voicememo's in de editor. Eén toggle-knop (play/pause)
 * + duur-label dat tijdens afspelen meebeweegt naar de huidige positie. Bewust
 * geen seekbar — minimale UI past in de horizontale embed-strip.
 */
@Composable
private fun AudioPlayerCard(uri: Uri, foreground: Color) {
    val context = LocalContext.current
    val player = remember(uri) { MediaPlayer() }
    var prepared by remember(uri) { mutableStateOf(false) }
    var playing by remember(uri) { mutableStateOf(false) }
    var durationMs by remember(uri) { mutableStateOf(0) }
    var positionMs by remember(uri) { mutableStateOf(0) }
    var failed by remember(uri) { mutableStateOf(false) }

    DisposableEffect(uri) {
        try {
            player.setDataSource(context, uri)
            player.setOnPreparedListener {
                prepared = true
                durationMs = player.duration.coerceAtLeast(0)
            }
            player.setOnCompletionListener {
                playing = false
                positionMs = 0
            }
            player.setOnErrorListener { _, _, _ ->
                failed = true
                playing = false
                true
            }
            player.prepareAsync()
        } catch (_: Exception) {
            failed = true
        }
        onDispose {
            try { player.stop() } catch (_: Exception) {}
            try { player.release() } catch (_: Exception) {}
        }
    }

    // Tijdens afspelen elke 250ms positie verversen voor het label.
    LaunchedEffect(playing) {
        while (playing) {
            positionMs = try { player.currentPosition } catch (_: Exception) { positionMs }
            kotlinx.coroutines.delay(250)
        }
    }

    val shownMs = if (playing || positionMs > 0) positionMs else durationMs
    val label = formatPlayerTime(shownMs)

    Surface(
        shape = RoundedCornerShape(8.dp),
        color = foreground.copy(alpha = 0.08f),
        modifier = Modifier
            .height(140.dp)
            .width(180.dp),
    ) {
        Column(
            modifier = Modifier.fillMaxSize().padding(12.dp),
            verticalArrangement = Arrangement.Center,
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            IconButton(
                onClick = {
                    if (failed || !prepared) return@IconButton
                    if (playing) {
                        try { player.pause() } catch (_: Exception) {}
                        playing = false
                    } else {
                        try { player.start() } catch (_: Exception) { return@IconButton }
                        playing = true
                    }
                },
                modifier = Modifier.size(56.dp),
            ) {
                Icon(
                    imageVector = if (playing) Icons.Filled.Pause else Icons.Filled.PlayArrow,
                    contentDescription = stringResource(
                        if (playing) R.string.audio_pause else R.string.audio_play
                    ),
                    tint = foreground,
                    modifier = Modifier.size(40.dp),
                )
            }
            Spacer(Modifier.height(4.dp))
            Text(
                text = if (failed) stringResource(R.string.audio_load_failed) else label,
                color = foreground,
                style = MaterialTheme.typography.bodySmall,
            )
        }
    }
}

private fun formatPlayerTime(ms: Int): String {
    val totalSec = (ms / 1000).coerceAtLeast(0)
    return "%d:%02d".format(totalSec / 60, totalSec % 60)
}

/**
 * Inline rij die de huidige reminder toont (of "geen herinnering") en knoppen
 * geeft om er een te kiezen / wissen. Bij tap op de tekst of de set-knop:
 * native DatePicker → TimePicker (twee dialogen na elkaar, simpelste UX op
 * Android zonder externe DateTime-picker-libs).
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ReminderEditor(
    reminder: String?,
    repeat: String?,
    until: String?,
    limit: Int?,
    onReminderChange: (String?) -> Unit,
    onRepeatChange: (String?) -> Unit,
    onUntilChange: (String?) -> Unit,
    onLimitChange: (Int?) -> Unit,
    onClear: () -> Unit,
    foreground: Color,
) {
    val context = LocalContext.current
    val display = formatReminderDisplay(reminder)

    var showDatePicker by remember { mutableStateOf(false) }
    var showTimePicker by remember { mutableStateOf<DateParts?>(null) }

    // POST_NOTIFICATIONS-permissie sinds Android 13. Just-in-time vragen:
    // alleen relevant als de gebruiker een reminder wil zetten.
    val notifPermLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { granted ->
        if (granted) {
            showDatePicker = true
        } else {
            Toast.makeText(context, R.string.reminder_permission_needed, Toast.LENGTH_LONG).show()
        }
    }
    val pick: () -> Unit = {
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.TIRAMISU &&
            androidx.core.content.ContextCompat.checkSelfPermission(
                context, android.Manifest.permission.POST_NOTIFICATIONS,
            ) != android.content.pm.PackageManager.PERMISSION_GRANTED
        ) {
            notifPermLauncher.launch(android.Manifest.permission.POST_NOTIFICATIONS)
        } else {
            showDatePicker = true
        }
    }

    Row(
        modifier = Modifier.fillMaxWidth(),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(
            Icons.Filled.Notifications,
            contentDescription = null,
            tint = foreground.copy(alpha = if (reminder != null) 0.9f else 0.5f),
            modifier = Modifier.size(20.dp),
        )
        Spacer(Modifier.width(8.dp))
        Text(
            text = display ?: stringResource(R.string.reminder_none),
            style = MaterialTheme.typography.bodyMedium,
            color = foreground.copy(alpha = if (reminder != null) 1f else 0.6f),
            modifier = Modifier
                .weight(1f)
                .clickable(onClick = pick),
        )
        if (reminder != null) {
            TextButton(onClick = onClear) {
                Text(stringResource(R.string.action_clear_reminder))
            }
        } else {
            TextButton(onClick = pick) {
                Text(stringResource(R.string.action_set_reminder))
            }
        }
    }

    if (showDatePicker) {
        val initial = parseReminderToCalendar(reminder) ?: defaultFutureCalendar()
        // Material3's DatePicker rekent in UTC-middernacht: zowel de initiële
        // selectie als selectedDateMillis. Lokale kalenders gebruiken zette
        // de herinnering in west-van-UTC-tijdzones een dag te vroeg.
        val initialUtc = Calendar.getInstance(TimeZone.getTimeZone("UTC")).apply {
            clear()
            set(initial.get(Calendar.YEAR), initial.get(Calendar.MONTH), initial.get(Calendar.DAY_OF_MONTH))
        }
        val datePickerState = rememberDatePickerState(
            initialSelectedDateMillis = initialUtc.timeInMillis,
        )
        DatePickerDialog(
            onDismissRequest = { showDatePicker = false },
            confirmButton = {
                TextButton(onClick = {
                    val millis = datePickerState.selectedDateMillis ?: return@TextButton
                    val cal = Calendar.getInstance(TimeZone.getTimeZone("UTC")).apply { timeInMillis = millis }
                    showDatePicker = false
                    showTimePicker = DateParts(
                        year = cal.get(Calendar.YEAR),
                        month = cal.get(Calendar.MONTH),
                        day = cal.get(Calendar.DAY_OF_MONTH),
                        initialHour = initial.get(Calendar.HOUR_OF_DAY),
                        initialMinute = initial.get(Calendar.MINUTE),
                    )
                }) {
                    Text(stringResource(android.R.string.ok))
                }
            },
            dismissButton = {
                TextButton(onClick = { showDatePicker = false }) {
                    Text(stringResource(android.R.string.cancel))
                }
            },
        ) {
            DatePicker(state = datePickerState)
        }
    }

    showTimePicker?.let { parts ->
        val timeState = rememberTimePickerState(
            initialHour = parts.initialHour,
            initialMinute = parts.initialMinute,
            is24Hour = android.text.format.DateFormat.is24HourFormat(context),
        )
        AlertDialog(
            onDismissRequest = { showTimePicker = null },
            title = { Text(stringResource(R.string.action_set_reminder)) },
            text = {
                // TimeInput = twee tekstvelden (HH:MM). Geen klokwijzer-gedoe.
                TimeInput(state = timeState)
            },
            confirmButton = {
                TextButton(onClick = {
                    val iso = String.format(
                        Locale.US,
                        "%04d-%02d-%02dT%02d:%02d",
                        parts.year, parts.month + 1, parts.day,
                        timeState.hour, timeState.minute,
                    )
                    showTimePicker = null
                    onReminderChange(iso)
                }) {
                    Text(stringResource(android.R.string.ok))
                }
            },
            dismissButton = {
                TextButton(onClick = { showTimePicker = null }) {
                    Text(stringResource(android.R.string.cancel))
                }
            },
        )
    }

    if (reminder != null) {
        Spacer(Modifier.height(4.dp))
        RepeatEditor(reminder = reminder, repeat = repeat, onChange = onRepeatChange, foreground = foreground)
        EndEditor(
            until = until,
            limit = limit,
            onUntilChange = onUntilChange,
            onLimitChange = onLimitChange,
            foreground = foreground,
        )
    }
}

@Composable
private fun RepeatEditor(reminder: String, repeat: String?, onChange: (String?) -> Unit, foreground: Color) {
    var expanded by remember { mutableStateOf(false) }
    var showWeekdayPicker by remember { mutableStateOf(false) }
    var showEveryPicker by remember { mutableStateOf(false) }
    var showOrdinalPicker by remember { mutableStateOf(false) }

    Row(
        modifier = Modifier.fillMaxWidth(),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(
            Icons.Filled.Notifications,
            contentDescription = null,
            tint = foreground.copy(alpha = 0.9f),
            modifier = Modifier.size(20.dp),
        )
        Spacer(Modifier.width(8.dp))
        Text(
            text = stringResource(R.string.repeat_label),
            style = MaterialTheme.typography.bodyMedium,
            color = foreground.copy(alpha = 0.7f),
            modifier = Modifier.weight(1f),
        )
        Box {
            TextButton(onClick = { expanded = true }) {
                Text(repeatLabel(repeat))
            }
            DropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
                DropdownMenuItem(text = { Text(stringResource(R.string.repeat_none)) }, onClick = {
                    expanded = false; onChange(null)
                })
                DropdownMenuItem(text = { Text(stringResource(R.string.repeat_daily)) }, onClick = {
                    expanded = false; onChange("daily")
                })
                DropdownMenuItem(text = { Text(stringResource(R.string.repeat_weekly)) }, onClick = {
                    expanded = false; showWeekdayPicker = true
                })
                DropdownMenuItem(text = { Text(stringResource(R.string.repeat_monthly)) }, onClick = {
                    expanded = false; onChange("monthly")
                })
                DropdownMenuItem(text = { Text(stringResource(R.string.repeat_yearly)) }, onClick = {
                    expanded = false; onChange("yearly")
                })
                DropdownMenuItem(text = { Text(stringResource(R.string.repeat_every)) }, onClick = {
                    expanded = false; showEveryPicker = true
                })
                DropdownMenuItem(text = { Text(stringResource(R.string.repeat_ordinal)) }, onClick = {
                    expanded = false; showOrdinalPicker = true
                })
            }
        }
    }

    if (showWeekdayPicker) {
        WeekdayPickerDialog(
            selected = (ReminderRecurrence.parseRepeat(repeat) as? RepeatRule.Weekly)?.weekdays
                ?: setOf(ReminderRecurrence.parseIso(reminder)?.dayOfWeek?.value ?: LocalDate.now().dayOfWeek.value),
            onConfirm = { days ->
                showWeekdayPicker = false
                onChange("weekly:" + days.sorted().joinToString(","))
            },
            onDismiss = { showWeekdayPicker = false },
        )
    }
    if (showEveryPicker) {
        EveryPickerDialog(
            onConfirm = { n, unit ->
                showEveryPicker = false
                onChange("every:$n:${unit.key}")
            },
            onDismiss = { showEveryPicker = false },
        )
    }
    if (showOrdinalPicker) {
        OrdinalPickerDialog(
            onConfirm = { k, weekday ->
                showOrdinalPicker = false
                onChange("ordinal:$k:$weekday")
            },
            onDismiss = { showOrdinalPicker = false },
        )
    }
}

@Composable
private fun EndEditor(
    until: String?,
    limit: Int?,
    onUntilChange: (String?) -> Unit,
    onLimitChange: (Int?) -> Unit,
    foreground: Color,
) {
    var expanded by remember { mutableStateOf(false) }
    var showLimitPicker by remember { mutableStateOf(false) }
    var showUntilPicker by remember { mutableStateOf(false) }

    Row(
        modifier = Modifier.fillMaxWidth(),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(
            Icons.Filled.Notifications,
            contentDescription = null,
            tint = foreground.copy(alpha = 0.9f),
            modifier = Modifier.size(20.dp),
        )
        Spacer(Modifier.width(8.dp))
        Text(
            text = stringResource(R.string.ends_label),
            style = MaterialTheme.typography.bodyMedium,
            color = foreground.copy(alpha = 0.7f),
            modifier = Modifier.weight(1f),
        )
        Box {
            TextButton(onClick = { expanded = true }) {
                Text(endLabel(until, limit))
            }
            DropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
                DropdownMenuItem(text = { Text(stringResource(R.string.ends_never)) }, onClick = {
                    expanded = false; onUntilChange(null); onLimitChange(null)
                })
                DropdownMenuItem(text = { Text(stringResource(R.string.ends_after)) }, onClick = {
                    expanded = false; showLimitPicker = true
                })
                DropdownMenuItem(text = { Text(stringResource(R.string.ends_on_date)) }, onClick = {
                    expanded = false; showUntilPicker = true
                })
            }
        }
    }

    if (showLimitPicker) {
        LimitPickerDialog(
            onConfirm = { n -> showLimitPicker = false; onUntilChange(null); onLimitChange(n) },
            onDismiss = { showLimitPicker = false },
        )
    }
    if (showUntilPicker) {
        UntilDatePickerDialog(
            initial = until,
            onConfirm = { date -> showUntilPicker = false; onLimitChange(null); onUntilChange(date) },
            onDismiss = { showUntilPicker = false },
        )
    }
}

@Composable
private fun EveryPickerDialog(onConfirm: (Int, RepeatUnit) -> Unit, onDismiss: () -> Unit) {
    var text by remember { mutableStateOf("1") }
    var unit by remember { mutableStateOf(RepeatUnit.DAYS) }
    var unitExpanded by remember { mutableStateOf(false) }
    val n = text.toIntOrNull() ?: 1

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.every_title)) },
        text = {
            Column {
                OutlinedTextField(
                    value = text,
                    onValueChange = { if (it.length <= 3 && it.all { c -> c.isDigit() }) text = it },
                    label = { Text(stringResource(R.string.every_title)) },
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                    singleLine = true,
                )
                Spacer(Modifier.height(8.dp))
                Box {
                    TextButton(onClick = { unitExpanded = true }) {
                        Text(
                            when (unit) {
                                RepeatUnit.DAYS -> stringResource(R.string.every_days)
                                RepeatUnit.WEEKS -> stringResource(R.string.every_weeks)
                                RepeatUnit.MONTHS -> stringResource(R.string.every_months)
                            },
                        )
                    }
                    DropdownMenu(expanded = unitExpanded, onDismissRequest = { unitExpanded = false }) {
                        DropdownMenuItem(text = { Text(stringResource(R.string.every_days)) }, onClick = {
                            unitExpanded = false; unit = RepeatUnit.DAYS
                        })
                        DropdownMenuItem(text = { Text(stringResource(R.string.every_weeks)) }, onClick = {
                            unitExpanded = false; unit = RepeatUnit.WEEKS
                        })
                        DropdownMenuItem(text = { Text(stringResource(R.string.every_months)) }, onClick = {
                            unitExpanded = false; unit = RepeatUnit.MONTHS
                        })
                    }
                }
            }
        },
        confirmButton = {
            TextButton(onClick = { onConfirm(n.coerceAtLeast(1), unit) }) {
                Text(stringResource(android.R.string.ok))
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) { Text(stringResource(android.R.string.cancel)) }
        },
    )
}

@Composable
private fun OrdinalPickerDialog(onConfirm: (Int, Int) -> Unit, onDismiss: () -> Unit) {
    var occurrence by remember { mutableStateOf(1) }
    var weekday by remember { mutableStateOf(1) }
    var occurrenceExpanded by remember { mutableStateOf(false) }
    var weekdayExpanded by remember { mutableStateOf(false) }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.ordinal_title)) },
        text = {
            Column {
                Box {
                    TextButton(onClick = { occurrenceExpanded = true }) {
                        Text(ordinalLabel(occurrence))
                    }
                    DropdownMenu(expanded = occurrenceExpanded, onDismissRequest = { occurrenceExpanded = false }) {
                        for (k in 1..5) {
                            DropdownMenuItem(text = { Text(ordinalLabel(k)) }, onClick = {
                                occurrenceExpanded = false; occurrence = k
                            })
                        }
                    }
                }
                Box {
                    TextButton(onClick = { weekdayExpanded = true }) {
                        Text(narrowWeekday(weekday))
                    }
                    DropdownMenu(expanded = weekdayExpanded, onDismissRequest = { weekdayExpanded = false }) {
                        for (d in 1..7) {
                            DropdownMenuItem(text = { Text(narrowWeekday(d)) }, onClick = {
                                weekdayExpanded = false; weekday = d
                            })
                        }
                    }
                }
            }
        },
        confirmButton = {
            TextButton(onClick = { onConfirm(occurrence, weekday) }) {
                Text(stringResource(android.R.string.ok))
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) { Text(stringResource(android.R.string.cancel)) }
        },
    )
}

@Composable
private fun WeekdayPickerDialog(
    selected: Set<Int>,
    onConfirm: (Set<Int>) -> Unit,
    onDismiss: () -> Unit,
) {
    var days by remember { mutableStateOf(selected) }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.repeat_weekly)) },
        text = {
            Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                for (d in 1..7) {
                    val active = d in days
                    Box(
                        modifier = Modifier
                            .clip(CircleShape)
                            .background(
                                if (active) MaterialTheme.colorScheme.primary.copy(alpha = 0.85f)
                                else MaterialTheme.colorScheme.onSurface.copy(alpha = 0.10f),
                            )
                            .selectable(
                                selected = active,
                                role = Role.Checkbox,
                                onClick = { days = if (active) days - d else days + d },
                            )
                            .padding(horizontal = 10.dp, vertical = 8.dp),
                    ) {
                        Text(
                            text = narrowWeekday(d),
                            color = if (active) MaterialTheme.colorScheme.onPrimary
                            else MaterialTheme.colorScheme.onSurface,
                        )
                    }
                }
            }
        },
        confirmButton = {
            TextButton(onClick = { onConfirm(days) }, enabled = days.isNotEmpty()) {
                Text(stringResource(android.R.string.ok))
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) { Text(stringResource(android.R.string.cancel)) }
        },
    )
}

@Composable
private fun LimitPickerDialog(onConfirm: (Int) -> Unit, onDismiss: () -> Unit) {
    var text by remember { mutableStateOf("3") }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.ends_after)) },
        text = {
            OutlinedTextField(
                value = text,
                onValueChange = { if (it.length <= 3 && it.all { c -> c.isDigit() }) text = it },
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                singleLine = true,
            )
        },
        confirmButton = {
            TextButton(onClick = { onConfirm((text.toIntOrNull() ?: 1).coerceAtLeast(1)) }) {
                Text(stringResource(android.R.string.ok))
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) { Text(stringResource(android.R.string.cancel)) }
        },
    )
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun UntilDatePickerDialog(
    initial: String?,
    onConfirm: (String) -> Unit,
    onDismiss: () -> Unit,
) {
    val initialDate = remember(initial) {
        runCatching { LocalDate.parse(initial) }
            .getOrNull()
            ?: LocalDate.now().plusDays(1)
    }
    val initialUtc = remember(initialDate) {
        Calendar.getInstance(TimeZone.getTimeZone("UTC")).apply {
            clear()
            set(initialDate.year, initialDate.monthValue - 1, initialDate.dayOfMonth)
        }.timeInMillis
    }
    val state = rememberDatePickerState(initialSelectedDateMillis = initialUtc)
    DatePickerDialog(
        onDismissRequest = onDismiss,
        confirmButton = {
            TextButton(onClick = {
                val millis = state.selectedDateMillis ?: return@TextButton
                val cal = Calendar.getInstance(TimeZone.getTimeZone("UTC")).apply { timeInMillis = millis }
                onConfirm(
                    String.format(
                        Locale.US, "%04d-%02d-%02d",
                        cal.get(Calendar.YEAR), cal.get(Calendar.MONTH) + 1, cal.get(Calendar.DAY_OF_MONTH),
                    ),
                )
            }) {
                Text(stringResource(android.R.string.ok))
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) { Text(stringResource(android.R.string.cancel)) }
        },
    ) {
        DatePicker(state = state)
    }
}

@Composable
private fun repeatLabel(repeat: String?): String {
    if (repeat.isNullOrBlank()) return stringResource(R.string.repeat_none)
    return when {
        repeat.equals("daily", true) -> stringResource(R.string.repeat_daily)
        repeat.equals("monthly", true) -> stringResource(R.string.repeat_monthly)
        repeat.equals("yearly", true) -> stringResource(R.string.repeat_yearly)
        repeat.startsWith("weekly:", true) -> {
            val days = repeat.substringAfter(':').split(',')
                .mapNotNull { it.trim().toIntOrNull() }
                .filter { it in 1..7 }
            if (days.isEmpty()) stringResource(R.string.repeat_weekly)
            else stringResource(R.string.repeat_weekly) + " (" + days.joinToString(", ") { narrowWeekday(it) } + ")"
        }
        repeat.startsWith("every:", true) -> {
            val rule = ReminderRecurrence.parseRepeat(repeat) as? RepeatRule.Every
            if (rule == null) {
                stringResource(R.string.repeat_every)
            } else {
                val unit = when (rule.unit) {
                    RepeatUnit.DAYS -> stringResource(R.string.every_days)
                    RepeatUnit.WEEKS -> stringResource(R.string.every_weeks)
                    RepeatUnit.MONTHS -> stringResource(R.string.every_months)
                }
                stringResource(R.string.every_title) + " ${rule.n} $unit"
            }
        }
        repeat.startsWith("ordinal:", true) -> {
            val rule = ReminderRecurrence.parseRepeat(repeat) as? RepeatRule.Ordinal
            if (rule == null) stringResource(R.string.repeat_ordinal)
            else ordinalLabel(rule.occurrence) + " " + narrowWeekday(rule.weekday)
        }
        else -> stringResource(R.string.repeat_none)
    }
}

@Composable
private fun endLabel(until: String?, limit: Int?): String {
    return when {
        limit != null && limit > 0 -> stringResource(R.string.ends_after_count, limit)
        until != null -> until
        else -> stringResource(R.string.ends_never)
    }
}

@Composable
private fun ordinalLabel(k: Int): String = stringResource(
    when (k) {
        2 -> R.string.ordinal_second
        3 -> R.string.ordinal_third
        4 -> R.string.ordinal_fourth
        5 -> R.string.ordinal_last
        else -> R.string.ordinal_first
    },
)

private fun narrowWeekday(iso: Int): String {
    return java.time.DayOfWeek.of(iso.coerceIn(1, 7))
        .getDisplayName(java.time.format.TextStyle.NARROW, Locale.getDefault())
}

/** Tijdelijke staat tussen date- en time-picker: bewaart gekozen datum + initiële tijd. */
private data class DateParts(
    val year: Int,
    val month: Int,
    val day: Int,
    val initialHour: Int,
    val initialMinute: Int,
)

private fun defaultFutureCalendar(): Calendar = Calendar.getInstance().apply {
    // Default 1 uur in de toekomst — zelden wil je iets exact "nu".
    add(Calendar.HOUR_OF_DAY, 1)
    set(Calendar.SECOND, 0)
    set(Calendar.MILLISECOND, 0)
}

private fun parseReminderToCalendar(iso: String?): Calendar? {
    if (iso.isNullOrBlank()) return null
    return try {
        val ldt = LocalDateTime.parse(iso, DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm"))
        Calendar.getInstance().apply {
            timeInMillis = ldt.atZone(ZoneId.systemDefault()).toInstant().toEpochMilli()
        }
    } catch (_: Throwable) {
        null
    }
}

private fun formatReminderDisplay(iso: String?): String? {
    if (iso.isNullOrBlank()) return null
    return try {
        val ldt = LocalDateTime.parse(iso, DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm"))
        ldt.format(DateTimeFormatter.ofPattern("EEE d MMM, HH:mm", Locale.getDefault()))
    } catch (_: Throwable) {
        iso
    }
}

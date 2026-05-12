package com.diexar.keepcapture

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.speech.RecognizerIntent
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.enableEdgeToEdge
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.FileProvider
import java.io.File
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
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
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import coil.compose.AsyncImage
import androidx.compose.ui.layout.ContentScale
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.AddAPhoto
import androidx.compose.material.icons.filled.Archive
import androidx.compose.material.icons.filled.CameraAlt
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.CheckBox
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Image
import androidx.compose.material.icons.filled.Link
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.Palette
import androidx.compose.material.icons.filled.TextFields
import androidx.compose.material.icons.filled.PushPin
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.diexar.keepcapture.ui.ObsiDropTheme
import com.diexar.keepcapture.ui.noteCardBrush
import com.diexar.keepcapture.ui.screenBackgroundBrush
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

class EditorActivity : ComponentActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        val noteUri: Uri? = intent.getStringExtra(EXTRA_NOTE_URI)?.let(Uri::parse)

        setContent {
            ObsiDropTheme {
                EditorScreen(
                    initialUri = noteUri,
                    onClose = { finish() },
                )
            }
        }
    }

    companion object {
        private const val EXTRA_NOTE_URI = "note_uri"

        fun newNoteIntent(context: Context): Intent =
            Intent(context, EditorActivity::class.java)

        fun openNoteIntent(context: Context, uri: Uri): Intent =
            Intent(context, EditorActivity::class.java).putExtra(EXTRA_NOTE_URI, uri.toString())
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun EditorScreen(initialUri: Uri?, onClose: () -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val dark = isSystemInDarkTheme()

    var currentUri by remember { mutableStateOf(initialUri?.toString()) }
    var loaded by remember { mutableStateOf(initialUri == null) }
    var loadError by remember { mutableStateOf<String?>(null) }
    var bodyText by remember { mutableStateOf(TextFieldValue("")) }
    var originalBody by remember { mutableStateOf("") }
    // Image-embed-regels (`![[basename]]`) leven los van de editor-tekst zodat ze
    // niet als ruwe markdown in beeld staan. We tonen ze als thumbnail-strip
    // boven het textveld en plakken ze terug bij opslaan.
    val embedLines = remember { mutableStateListOf<String>() }
    var originalEmbeds by remember { mutableStateOf<List<String>>(emptyList()) }
    var color by remember { mutableStateOf(NoteColor.DEFAULT) }
    var pinned by remember { mutableStateOf(false) }
    val tags = remember { mutableStateListOf<String>() }
    var saving by remember { mutableStateOf(false) }
    var showArchiveDialog by remember { mutableStateOf(false) }
    var showDeleteDialog by remember { mutableStateOf(false) }
    var showColorPicker by remember { mutableStateOf(false) }
    var showLinkPicker by remember { mutableStateOf(false) }
    var photoMenuExpanded by remember { mutableStateOf(false) }
    var pendingCameraUri by remember { mutableStateOf<Uri?>(null) }
    var pendingCameraFile by remember { mutableStateOf<File?>(null) }
    var pendingOcr by remember { mutableStateOf(false) }

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
            bodyText = TextFieldValue(text = newText, selection = TextRange(cursorPos))
        }
        embedLines.add("![[" + basename + "]]")
    }

    fun handleImageUri(uri: Uri, cleanupFile: File?, withOcr: Boolean) {
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
                Storage.copyImageToAttachments(context, uri)
            }
            cleanupFile?.delete()
            result.onSuccess { basename ->
                if (withOcr) insertOcrAndEmbed(basename, ocrText)
                else insertImageEmbed(basename)
            }.onFailure { err ->
                Toast.makeText(
                    context,
                    context.getString(R.string.photo_error, err.message ?: err.javaClass.simpleName),
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

    fun toggleOrInsertChecklist() {
        val current = bodyText
        val text = current.text
        val caret = current.selection.start.coerceIn(0, text.length)
        // Begin van de regel waar de cursor staat.
        val lineStart = text.lastIndexOf('\n', (caret - 1).coerceAtLeast(0)).let { if (it < 0) 0 else it + 1 }
        val lineEnd = text.indexOf('\n', caret).let { if (it < 0) text.length else it }
        val line = text.substring(lineStart, lineEnd)

        val (newLine, caretDelta) = when {
            // - [ ]  → - [x]
            line.startsWith("- [ ] ") -> "- [x] " + line.substring(6) to 0
            line.startsWith("- [ ]") -> "- [x]" + line.substring(5) to 0
            // - [x]/- [X] → - [ ]
            line.startsWith("- [x] ") || line.startsWith("- [X] ") -> "- [ ] " + line.substring(6) to 0
            line.startsWith("- [x]") || line.startsWith("- [X]") -> "- [ ]" + line.substring(5) to 0
            // Geen checkbox op deze regel — voeg er één in aan begin van regel.
            else -> "- [ ] " + line to "- [ ] ".length
        }

        val newText = text.substring(0, lineStart) + newLine + text.substring(lineEnd)
        val newCaret = (caret + caretDelta).coerceIn(0, newText.length)
        bodyText = TextFieldValue(text = newText, selection = TextRange(newCaret))
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
        bodyText = TextFieldValue(text = newText, selection = TextRange(cursorPos))
    }

    val speechLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        if (result.resultCode != Activity.RESULT_OK) return@rememberLauncherForActivityResult
        val matches = result.data?.getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS)
        val recognized = matches?.firstOrNull()?.trim().orEmpty()
        if (recognized.isNotEmpty()) insertText(recognized)
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

    LaunchedEffect(initialUri) {
        if (initialUri != null && !loaded) {
            val result = withContext(Dispatchers.IO) {
                runCatching {
                    Storage.readNote(context, initialUri).getOrThrow()
                }
            }
            result.onSuccess { raw ->
                try {
                    val parsed = FrontmatterParser.parse(raw)
                    val cleanBody = parsed.body.removePrefix("\n")
                    val (textPart, embeds) = splitBodyAndEmbeds(cleanBody)
                    bodyText = TextFieldValue(textPart)
                    originalBody = textPart
                    embedLines.clear()
                    embedLines.addAll(embeds)
                    originalEmbeds = embeds.toList()
                    color = parsed.meta.color
                    pinned = parsed.meta.pinned
                    tags.clear()
                    tags.addAll(parsed.meta.tags)
                } catch (e: Throwable) {
                    loadError = context.getString(R.string.parse_error, e.message ?: e.javaClass.simpleName)
                }
                loaded = true
            }.onFailure { err ->
                loadError = err.message ?: context.getString(R.string.error_unknown)
                loaded = true
            }
        }
    }

    val isDirty = loaded && (bodyText.text != originalBody || embedLines.toList() != originalEmbeds)
    val isExisting = currentUri != null
    val bg = noteBackground(color, dark)
    val fg = contentColorOn(color, dark)
    // DEFAULT-notities krijgen de sunset-screen-gradient; gekleurde notities
    // krijgen een lichte diagonale gradient op hun pastel zodat het kaart-gevoel
    // doorloopt in de editor. Memoizen voorkomt nieuwe Brush per recomposition.
    val editorBrush = remember(color, dark, bg) {
        if (color == NoteColor.DEFAULT) screenBackgroundBrush(dark) else noteCardBrush(bg, dark)
    }

    fun applyMetaAsync(newColor: NoteColor = color, newPinned: Boolean = pinned, newTags: List<String> = tags.toList()) {
        val uri = currentUri ?: return
        scope.launch {
            val newMeta = NoteMeta(color = newColor, tags = newTags, pinned = newPinned)
            withContext(Dispatchers.IO) {
                Storage.updateNoteMeta(context, Uri.parse(uri), newMeta)
            }
        }
    }

    fun closeWithSaveIfNeeded() {
        attemptSaveAndClose(
            scope = scope,
            context = context,
            bodyText = bodyText.text,
            embedLines = embedLines.toList(),
            currentUri = currentUri,
            color = color,
            pinned = pinned,
            tags = tags.toList(),
            isDirty = isDirty,
            onSavingChange = { saving = it },
            onSaved = { newUri ->
                if (newUri != null) currentUri = newUri.toString()
                originalBody = bodyText.text
                originalEmbeds = embedLines.toList()
                onClose()
            },
            onError = { msg ->
                Toast.makeText(context, msg, Toast.LENGTH_LONG).show()
            },
            closeWhenClean = true,
            onClose = onClose,
        )
    }

    BackHandler(enabled = true) { closeWithSaveIfNeeded() }

    Box(modifier = Modifier.fillMaxSize().background(brush = editorBrush)) {
    Scaffold(
        containerColor = Color.Transparent,
        topBar = {
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
                    IconButton(onClick = {
                        pinned = !pinned
                        if (isExisting) applyMetaAsync(newPinned = pinned)
                    }) {
                        Icon(
                            Icons.Filled.PushPin,
                            contentDescription = stringResource(if (pinned) R.string.action_unpin else R.string.action_pin),
                            tint = if (pinned) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurface,
                        )
                    }
                    IconButton(onClick = { showColorPicker = true }) {
                        Icon(Icons.Filled.Palette, contentDescription = stringResource(R.string.action_color))
                    }
                    IconButton(onClick = { showLinkPicker = true }) {
                        Icon(Icons.Filled.Link, contentDescription = stringResource(R.string.action_link))
                    }
                    IconButton(onClick = { toggleOrInsertChecklist() }) {
                        Icon(Icons.Filled.CheckBox, contentDescription = stringResource(R.string.action_checklist))
                    }
                    IconButton(onClick = { launchSpeech() }) {
                        Icon(Icons.Filled.Mic, contentDescription = stringResource(R.string.action_speech))
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
                    if (isExisting) {
                        IconButton(onClick = { showArchiveDialog = true }) {
                            Icon(Icons.Filled.Archive, contentDescription = stringResource(R.string.action_archive))
                        }
                        IconButton(onClick = { showDeleteDialog = true }) {
                            Icon(Icons.Filled.Delete, contentDescription = stringResource(R.string.action_delete))
                        }
                    }
                    IconButton(
                        enabled = !saving && (bodyText.text.isNotBlank() || embedLines.isNotEmpty()) && (isDirty || !isExisting),
                        onClick = {
                            attemptSaveAndClose(
                                scope = scope,
                                context = context,
                                bodyText = bodyText.text,
                                embedLines = embedLines.toList(),
                                currentUri = currentUri,
                                color = color,
                                pinned = pinned,
                                tags = tags.toList(),
                                isDirty = true,
                                onSavingChange = { saving = it },
                                onSaved = { newUri ->
                                    if (newUri != null) currentUri = newUri.toString()
                                    originalBody = bodyText.text
                                    originalEmbeds = embedLines.toList()
                                    Toast.makeText(context, R.string.toast_saved_short, Toast.LENGTH_SHORT).show()
                                    onClose()
                                },
                                onError = { msg ->
                                    Toast.makeText(context, msg, Toast.LENGTH_LONG).show()
                                },
                                closeWhenClean = false,
                                onClose = onClose,
                            )
                        },
                    ) {
                        Icon(Icons.Filled.Check, contentDescription = stringResource(R.string.action_save))
                    }
                },
            )
        },
    ) { padding ->
        Box(modifier = Modifier.fillMaxSize().padding(padding)) {
            when {
                !loaded -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    CircularProgressIndicator()
                }
                loadError != null -> Box(Modifier.fillMaxSize().padding(24.dp), contentAlignment = Alignment.Center) {
                    Text(
                        text = stringResource(R.string.error_with_message, loadError ?: ""),
                        style = MaterialTheme.typography.bodyMedium,
                        color = fg,
                    )
                }
                else -> EditorBody(
                    value = bodyText,
                    onValueChange = { bodyText = it },
                    embedBasenames = embedLines.mapNotNull { extractEmbedBasename(it) },
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
                    foreground = fg,
                )
            }
        }
    }
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
                bodyText = TextFieldValue(
                    text = newText,
                    selection = androidx.compose.ui.text.TextRange(start + insert.length)
                )
            },
            onDismiss = { showLinkPicker = false },
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
                    val res = withContext(Dispatchers.IO) {
                        Storage.archiveNote(context, Uri.parse(uri))
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
            message = stringResource(R.string.delete_message),
            confirmLabel = stringResource(R.string.action_delete),
            onConfirm = {
                showDeleteDialog = false
                val uri = currentUri ?: return@ConfirmDialog
                scope.launch {
                    val res = withContext(Dispatchers.IO) {
                        Storage.deleteNote(context, Uri.parse(uri))
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
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun EditorBody(
    value: TextFieldValue,
    onValueChange: (TextFieldValue) -> Unit,
    embedBasenames: List<String>,
    tags: List<String>,
    onAddTag: (String) -> Unit,
    onRemoveTag: (String) -> Unit,
    foreground: Color,
) {
    val context = LocalContext.current
    val embedUris = remember(embedBasenames) {
        embedBasenames.mapNotNull { Storage.findAttachmentUri(context, it) }
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(horizontal = 16.dp, vertical = 12.dp),
    ) {
        if (embedUris.isNotEmpty()) {
            // Horizontaal scrollbare strip: anders eten meerdere previews het halve scherm
            // op en kun je nauwelijks nog door de tekst scrollen.
            val embedScroll = rememberScrollState()
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .horizontalScroll(embedScroll),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                for (uri in embedUris) {
                    AsyncImage(
                        model = uri,
                        contentDescription = null,
                        contentScale = ContentScale.Crop,
                        modifier = Modifier
                            .height(140.dp)
                            .aspectRatio(4f / 3f)
                            .clip(RoundedCornerShape(8.dp)),
                    )
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
        Spacer(Modifier.height(12.dp))
        HorizontalDivider(color = foreground.copy(alpha = 0.15f))
        Spacer(Modifier.height(12.dp))
        TextField(
            value = value,
            onValueChange = onValueChange,
            modifier = Modifier
                .fillMaxWidth()
                .weight(1f),
            placeholder = { Text(stringResource(R.string.editor_hint), color = foreground.copy(alpha = 0.5f)) },
            keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences),
            colors = TextFieldDefaults.colors(
                focusedContainerColor = Color.Transparent,
                unfocusedContainerColor = Color.Transparent,
                focusedTextColor = foreground,
                unfocusedTextColor = foreground,
                cursorColor = foreground,
                focusedIndicatorColor = Color.Transparent,
                unfocusedIndicatorColor = Color.Transparent,
            ),
        )
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun TagEditor(
    tags: List<String>,
    onAdd: (String) -> Unit,
    onRemove: (String) -> Unit,
    foreground: Color,
) {
    var input by remember { mutableStateOf("") }

    fun commit() {
        val v = input.removePrefix("#").trim()
        if (v.isNotEmpty()) onAdd(v)
        input = ""
    }

    Column {
        if (tags.isNotEmpty()) {
            val scrollState = rememberScrollState()
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .horizontalScroll(scrollState),
                horizontalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                for (tag in tags) {
                    EditorTagChip(tag, foreground = foreground, onRemove = { onRemove(tag) })
                }
            }
            Spacer(Modifier.height(6.dp))
        }
        OutlinedTextField(
            value = input,
            onValueChange = { value ->
                if (value.contains('\n') || value.endsWith(",") || value.endsWith(" ")) {
                    val toCommit = value.replace("\n", "").trimEnd(',', ' ').trim()
                    if (toCommit.isNotEmpty()) onAdd(toCommit.removePrefix("#"))
                    input = ""
                } else {
                    input = value
                }
            },
            modifier = Modifier.fillMaxWidth(),
            placeholder = { Text(stringResource(R.string.tag_placeholder), color = foreground.copy(alpha = 0.5f)) },
            singleLine = true,
            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
            keyboardActions = KeyboardActions(onDone = { commit() }),
            colors = TextFieldDefaults.colors(
                focusedContainerColor = Color.Transparent,
                unfocusedContainerColor = Color.Transparent,
                focusedTextColor = foreground,
                unfocusedTextColor = foreground,
                cursorColor = foreground,
                focusedIndicatorColor = foreground.copy(alpha = 0.4f),
                unfocusedIndicatorColor = foreground.copy(alpha = 0.2f),
            ),
            textStyle = TextStyle(color = foreground, fontSize = MaterialTheme.typography.bodyMedium.fontSize),
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

@Composable
private fun ColorPickerDialog(
    current: NoteColor,
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
                Spacer(Modifier.height(8.dp))
                Text(
                    text = stringResource(R.string.color_label, stringResource(current.labelRes)),
                    style = MaterialTheme.typography.bodySmall,
                )
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
    embedLines: List<String>,
    currentUri: String?,
    color: NoteColor,
    pinned: Boolean,
    tags: List<String>,
    isDirty: Boolean,
    onSavingChange: (Boolean) -> Unit,
    onSaved: (Uri?) -> Unit,
    onError: (String) -> Unit,
    closeWhenClean: Boolean,
    onClose: () -> Unit,
) {
    val meta = NoteMeta(color = color, tags = tags, pinned = pinned)
    if (!isDirty && currentUri != null) {
        // Metadata is bij bestaande notities al onmiddellijk gesynct; alleen sluiten.
        if (closeWhenClean) onClose()
        return
    }
    val combinedBody = combineBodyAndEmbeds(bodyText, embedLines)
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
            if (currentUri != null) {
                // Body wijzigt — herschrijf bestand met behoud van frontmatter.
                val rawCurrent = Storage.readNote(context, Uri.parse(currentUri))
                    .getOrElse { return@withContext Result.failure(it) }
                val parsed = FrontmatterParser.parse(rawCurrent)
                val fmBlock = parsed.frontmatter
                val newRaw = if (fmBlock.isEmpty()) combinedBody else fmBlock + combinedBody
                // Pas eerst meta toe (geeft consistente frontmatter), dan write.
                Storage.updateNote(context, Uri.parse(currentUri), FrontmatterWriter.apply(newRaw, meta)).map { null }
            } else {
                // Nieuwe notitie: body + meta in één keer wegschrijven.
                val combined = FrontmatterWriter.apply(combinedBody, meta)
                Storage.createNote(context, combined).map { it.second }
            }
        }
        onSavingChange(false)
        result.onSuccess { newUri -> onSaved(newUri) }
            .onFailure { err ->
                onError(context.getString(R.string.toast_error, err.message ?: ""))
            }
    }
}

/**
 * Scheidt een body in twee delen: tekst (zonder embed-only regels) en de
 * embed-regels los. Behoudt blank-line-structuur in de tekst, behalve een
 * eventuele dubbele newline die ontstaat door het wegfilteren van een embed.
 */
private val EMBED_LINE_REGEX = Regex("^\\s*!\\[\\[[^\\]]+]]\\s*$")

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


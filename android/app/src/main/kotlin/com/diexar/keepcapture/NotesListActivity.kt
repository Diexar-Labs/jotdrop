package com.diexar.keepcapture

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.text.format.DateUtils
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.FileProvider
import java.io.File
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.lazy.staggeredgrid.LazyVerticalStaggeredGrid
import androidx.compose.foundation.lazy.staggeredgrid.StaggeredGridCells
import androidx.compose.foundation.lazy.staggeredgrid.StaggeredGridItemSpan
import androidx.compose.foundation.lazy.staggeredgrid.items
import androidx.compose.foundation.text.ClickableText
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.AddAPhoto
import androidx.compose.material.icons.filled.CameraAlt
import androidx.compose.material.icons.filled.Image
import androidx.compose.material.icons.filled.PushPin
import androidx.compose.material.icons.filled.TextFields
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.Button
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.SmallFloatingActionButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarDuration
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.SnackbarResult
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.lifecycle.lifecycleScope
import coil.compose.AsyncImage
import com.diexar.keepcapture.ui.ObsiDropTheme
import com.diexar.keepcapture.ui.noteCardBrush
import com.diexar.keepcapture.ui.screenBackgroundBrush
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

class NotesListActivity : ComponentActivity() {

    private val notesState = MutableStateFlow<NotesUiState>(NotesUiState.Loading)
    private var pendingCameraUri: Uri? = null
    private var pendingCameraFile: File? = null
    // OCR-modus blijft staan tot de capture-flow afgerond is. Met deze flag weet
    // de result-callback of er na de copy ook nog OCR moet draaien.
    private var pendingOcr: Boolean = false

    private val takePictureLauncher = registerForActivityResult(
        ActivityResultContracts.TakePicture()
    ) { success ->
        val uri = pendingCameraUri
        val file = pendingCameraFile
        val ocr = pendingOcr
        pendingCameraUri = null
        pendingCameraFile = null
        pendingOcr = false
        if (success && uri != null) {
            saveCapturedImage(uri, deleteSourceAfter = file, withOcr = ocr)
        } else {
            // Gebruiker annuleerde of capture mislukte — temp file opruimen.
            file?.delete()
        }
    }

    private val pickImageLauncher = registerForActivityResult(
        ActivityResultContracts.PickVisualMedia()
    ) { uri ->
        val ocr = pendingOcr
        pendingOcr = false
        if (uri != null) saveCapturedImage(uri, deleteSourceAfter = null, withOcr = ocr)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        setContent {
            ObsiDropTheme {
                NotesListScreen(
                    stateFlow = notesState.asStateFlow(),
                    onRefresh = { reload() },
                    onOpenSettings = {
                        startActivity(Intent(this, MainActivity::class.java))
                    },
                    onNewNote = {
                        if (requireVaultOrPromptSettings()) {
                            startActivity(EditorActivity.newNoteIntent(this))
                        }
                    },
                    onTakePhoto = {
                        if (requireVaultOrPromptSettings()) launchCamera(withOcr = false)
                    },
                    onPickPhoto = {
                        if (requireVaultOrPromptSettings()) launchPicker(withOcr = false)
                    },
                    onOcrCamera = {
                        if (requireVaultOrPromptSettings()) launchCamera(withOcr = true)
                    },
                    onOcrGallery = {
                        if (requireVaultOrPromptSettings()) launchPicker(withOcr = true)
                    },
                    onOpenNote = { note ->
                        startActivity(EditorActivity.openNoteIntent(this, note.uri))
                    },
                    onTogglePin = { note ->
                        togglePin(note)
                    },
                )
            }
        }
    }

    private fun requireVaultOrPromptSettings(): Boolean {
        if (Storage.getVaultUri(this) != null) return true
        Toast.makeText(this, R.string.error_no_vault, Toast.LENGTH_SHORT).show()
        startActivity(Intent(this, MainActivity::class.java))
        return false
    }

    private fun launchCamera(withOcr: Boolean) {
        val file = File(cacheDir, "camera-${System.currentTimeMillis()}.jpg")
        val uri = try {
            FileProvider.getUriForFile(this, "$packageName.fileprovider", file)
        } catch (e: Exception) {
            Toast.makeText(this, getString(R.string.camera_error, e.message ?: e.javaClass.simpleName), Toast.LENGTH_SHORT).show()
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
            Toast.makeText(this, R.string.no_camera_app, Toast.LENGTH_SHORT).show()
        }
    }

    private fun launchPicker(withOcr: Boolean) {
        pendingOcr = withOcr
        pickImageLauncher.launch(
            PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)
        )
    }

    private fun saveCapturedImage(uri: Uri, deleteSourceAfter: File?, withOcr: Boolean) {
        lifecycleScope.launch {
            if (withOcr) {
                Toast.makeText(this@NotesListActivity, R.string.ocr_running, Toast.LENGTH_SHORT).show()
            }
            // OCR draait op de bron-URI vóór de kopie, omdat ML Kit een leesbare
            // Uri nodig heeft die in de huidige flow nog gegrant is.
            val ocrText: String = if (withOcr) {
                val ocrResult = OcrService.recognizeFromUri(this@NotesListActivity, uri)
                ocrResult.getOrElse { err ->
                    Toast.makeText(
                        this@NotesListActivity,
                        getString(R.string.ocr_failed, err.message ?: err.javaClass.simpleName),
                        Toast.LENGTH_LONG,
                    ).show()
                    ""
                }
            } else ""

            if (withOcr && ocrText.isBlank()) {
                Toast.makeText(this@NotesListActivity, R.string.ocr_no_text, Toast.LENGTH_SHORT).show()
            }

            val result = withContext(Dispatchers.IO) {
                Storage.saveImageNote(
                    this@NotesListActivity,
                    uri,
                    subject = null,
                    extraText = ocrText.ifBlank { null },
                )
            }
            deleteSourceAfter?.delete()
            result.onSuccess { filename ->
                Toast.makeText(
                    this@NotesListActivity,
                    getString(R.string.toast_saved, filename),
                    Toast.LENGTH_SHORT,
                ).show()
                reload()
            }.onFailure { err ->
                Toast.makeText(
                    this@NotesListActivity,
                    getString(R.string.toast_error, err.message ?: "onbekende fout"),
                    Toast.LENGTH_SHORT,
                ).show()
            }
        }
    }

    override fun onResume() {
        super.onResume()
        reload()
    }

    private fun reload() {
        if (Storage.getVaultUri(this) == null) {
            notesState.value = NotesUiState.NoVault
            return
        }
        notesState.value = NotesUiState.Loading
        lifecycleScope.launch {
            val result = withContext(Dispatchers.IO) { Storage.listNotes(this@NotesListActivity) }
            notesState.value = result.fold(
                onSuccess = { NotesUiState.Loaded(sortNotes(it)) },
                onFailure = { NotesUiState.Error(it.message ?: getString(R.string.error_unknown)) },
            )
        }
    }

    private fun togglePin(note: NoteSummary) {
        lifecycleScope.launch {
            val newMeta = note.meta.copy(pinned = !note.meta.pinned)
            val result = withContext(Dispatchers.IO) {
                Storage.updateNoteMeta(this@NotesListActivity, note.uri, newMeta)
            }
            result.onFailure { err ->
                Toast.makeText(this@NotesListActivity, err.message ?: getString(R.string.error_generic), Toast.LENGTH_SHORT).show()
            }
            reload()
        }
    }
}

private fun sortNotes(notes: List<NoteSummary>): List<NoteSummary> {
    return notes.sortedWith(
        compareByDescending<NoteSummary> { it.meta.pinned }
            .thenByDescending { it.lastModified }
    )
}

sealed interface NotesUiState {
    data object Loading : NotesUiState
    data object NoVault : NotesUiState
    data class Loaded(val notes: List<NoteSummary>) : NotesUiState
    data class Error(val message: String) : NotesUiState
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun NotesListScreen(
    stateFlow: StateFlow<NotesUiState>,
    onRefresh: () -> Unit,
    onOpenSettings: () -> Unit,
    onNewNote: () -> Unit,
    onTakePhoto: () -> Unit,
    onPickPhoto: () -> Unit,
    onOcrCamera: () -> Unit,
    onOcrGallery: () -> Unit,
    onOpenNote: (NoteSummary) -> Unit,
    onTogglePin: (NoteSummary) -> Unit,
) {
    val state by stateFlow.collectAsState()
    val snackbarHostState = remember { SnackbarHostState() }
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    val openLinkLabel = stringResource(R.string.action_open_link)
    val dark = isSystemInDarkTheme()
    val bgBrush = remember(dark) { screenBackgroundBrush(dark) }

    val onUrlClick: (String) -> Unit = { url ->
        scope.launch {
            val result = snackbarHostState.showSnackbar(
                message = url,
                actionLabel = openLinkLabel,
                duration = SnackbarDuration.Short,
                withDismissAction = true,
            )
            if (result == SnackbarResult.ActionPerformed) {
                try {
                    val intent = Intent(Intent.ACTION_VIEW, Uri.parse(url)).apply {
                        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    }
                    context.startActivity(intent)
                } catch (e: Throwable) {
                    Toast.makeText(
                        context,
                        context.getString(R.string.toast_error, e.message ?: ""),
                        Toast.LENGTH_SHORT,
                    ).show()
                }
            }
        }
    }

    Box(modifier = Modifier.fillMaxSize().background(bgBrush)) {
    Scaffold(
        containerColor = Color.Transparent,
        topBar = {
            TopAppBar(
                title = {
                    Text(
                        stringResource(R.string.app_name),
                        style = MaterialTheme.typography.titleLarge,
                        fontWeight = FontWeight.SemiBold,
                    )
                },
                actions = {
                    IconButton(onClick = onOpenSettings) {
                        Icon(Icons.Filled.Settings, contentDescription = stringResource(R.string.action_settings))
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = Color.Transparent,
                    scrolledContainerColor = Color.Transparent,
                ),
            )
        },
        floatingActionButton = {
            Column(horizontalAlignment = Alignment.End) {
                var photoMenuExpanded by remember { mutableStateOf(false) }
                Box {
                    SmallFloatingActionButton(onClick = { photoMenuExpanded = true }) {
                        Icon(Icons.Filled.AddAPhoto, contentDescription = stringResource(R.string.action_add_photo))
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
                                onTakePhoto()
                            },
                        )
                        DropdownMenuItem(
                            text = { Text(stringResource(R.string.action_pick_from_gallery)) },
                            leadingIcon = { Icon(Icons.Filled.Image, contentDescription = null) },
                            onClick = {
                                photoMenuExpanded = false
                                onPickPhoto()
                            },
                        )
                        DropdownMenuItem(
                            text = { Text(stringResource(R.string.action_ocr_camera)) },
                            leadingIcon = { Icon(Icons.Filled.TextFields, contentDescription = null) },
                            onClick = {
                                photoMenuExpanded = false
                                onOcrCamera()
                            },
                        )
                        DropdownMenuItem(
                            text = { Text(stringResource(R.string.action_ocr_gallery)) },
                            leadingIcon = { Icon(Icons.Filled.TextFields, contentDescription = null) },
                            onClick = {
                                photoMenuExpanded = false
                                onOcrGallery()
                            },
                        )
                    }
                }
                Spacer(Modifier.height(12.dp))
                FloatingActionButton(onClick = onNewNote) {
                    Icon(Icons.Filled.Add, contentDescription = stringResource(R.string.action_new_note))
                }
            }
        },
        snackbarHost = { SnackbarHost(snackbarHostState) },
    ) { padding ->
        Box(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding),
        ) {
            when (val s = state) {
                NotesUiState.Loading -> CenteredText(stringResource(R.string.loading))
                NotesUiState.NoVault -> EmptyState(
                    text = stringResource(R.string.empty_no_vault),
                    actionLabel = stringResource(R.string.open_settings),
                    onAction = onOpenSettings,
                )
                is NotesUiState.Error -> EmptyState(
                    text = stringResource(R.string.error_with_message, s.message),
                    actionLabel = stringResource(R.string.retry),
                    onAction = onRefresh,
                )
                is NotesUiState.Loaded -> {
                    if (s.notes.isEmpty()) {
                        CenteredText(stringResource(R.string.empty_no_notes))
                    } else {
                        NotesGrid(
                            notes = s.notes,
                            onOpenNote = onOpenNote,
                            onTogglePin = onTogglePin,
                            onUrlClick = onUrlClick,
                        )
                    }
                }
            }
        }
    }
    }
}

@Composable
private fun NotesGrid(
    notes: List<NoteSummary>,
    onOpenNote: (NoteSummary) -> Unit,
    onTogglePin: (NoteSummary) -> Unit,
    onUrlClick: (String) -> Unit,
) {
    val pinned = notes.filter { it.meta.pinned }
    val rest = notes.filter { !it.meta.pinned }
    val dark = isSystemInDarkTheme()
    // Vast 2 kolommen in portrait (Google Keep-style), 4 in landscape voor tablets/
    // brede telefoons in liggend. Geen Adaptive — consistente look ongeacht zoom.
    val isLandscape = LocalConfiguration.current.screenWidthDp >= 600
    val columnCount = if (isLandscape) 4 else 2

    LazyVerticalStaggeredGrid(
        columns = StaggeredGridCells.Fixed(columnCount),
        contentPadding = PaddingValues(horizontal = 10.dp, vertical = 8.dp),
        verticalItemSpacing = 10.dp,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
        modifier = Modifier.fillMaxSize(),
    ) {
        if (pinned.isNotEmpty()) {
            item(span = StaggeredGridItemSpan.FullLine) {
                SectionLabel(stringResource(R.string.section_pinned))
            }
            items(pinned, key = { "p-" + it.uri.toString() }) { note ->
                NoteCard(
                    note = note,
                    darkTheme = dark,
                    onClick = { onOpenNote(note) },
                    onPinClick = { onTogglePin(note) },
                    onUrlClick = onUrlClick,
                )
            }
            item(span = StaggeredGridItemSpan.FullLine) {
                SectionLabel(stringResource(R.string.section_other))
            }
        }
        items(rest, key = { it.uri.toString() }) { note ->
            NoteCard(
                note = note,
                darkTheme = dark,
                onClick = { onOpenNote(note) },
                onPinClick = { onTogglePin(note) },
                onUrlClick = onUrlClick,
            )
        }
    }
}

@Composable
private fun SectionLabel(text: String) {
    Text(
        text = text.uppercase(),
        style = MaterialTheme.typography.labelSmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.padding(start = 4.dp, top = 4.dp, bottom = 4.dp),
    )
}

private val CARD_SHAPE = RoundedCornerShape(16.dp)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun NoteCard(
    note: NoteSummary,
    darkTheme: Boolean,
    onClick: () -> Unit,
    onPinClick: () -> Unit,
    onUrlClick: (String) -> Unit,
) {
    val bg = noteBackground(note.meta.color, darkTheme)
    val fg = contentColorOn(note.meta.color, darkTheme)
    // Brush + BorderStroke memoizen — Brush.linearGradient maakt anders bij elke
    // recomposition een nieuw object aan en dat zorgt voor GC-druk tijdens scroll.
    // CardDefaults.cardColors/cardElevation zijn @Composable en kunnen niet in
    // remember-blokken; die laten we Compose zelf afhandelen.
    val brush = remember(bg, darkTheme) { noteCardBrush(bg, darkTheme) }
    val border = remember(fg) {
        androidx.compose.foundation.BorderStroke(0.7.dp, fg.copy(alpha = 0.08f))
    }
    val accent = remember(note.meta.color, fg) { accentOn(note.meta.color, fg) }
    val timestampText = remember(note.lastModified) { formatTimestamp(note.lastModified) }
    val timestampColor = remember(fg) { fg.copy(alpha = 0.7f) }
    // TextStyle.copy maakt anders een nieuwe TextStyle per recomposition; memoizen
    // bespaart per-frame allocations.
    val baseSnippetStyle = MaterialTheme.typography.bodySmall
    val snippetStyle = remember(baseSnippetStyle, fg) { baseSnippetStyle.copy(color = fg) }
    val labelStyle = MaterialTheme.typography.labelSmall

    val thumbnailUri = note.thumbnailUri

    Card(
        onClick = onClick,
        colors = CardDefaults.cardColors(containerColor = Color.Transparent, contentColor = fg),
        elevation = CardDefaults.cardElevation(defaultElevation = 0.dp),
        shape = CARD_SHAPE,
        border = border,
        // graphicsLayer promoot de kaart naar een eigen render-layer; tijdens
        // scroll wordt de rasterized output gehergebruikt i.p.v. de gradient +
        // text+border opnieuw te tekenen per frame. Voorkomt frame drops.
        modifier = Modifier.graphicsLayer { },
    ) {
        Box(modifier = Modifier.fillMaxSize().background(brush = brush)) {
            Column {
                if (thumbnailUri != null) {
                    AsyncImage(
                        model = thumbnailUri,
                        contentDescription = null,
                        contentScale = ContentScale.Crop,
                        modifier = Modifier
                            .fillMaxWidth()
                            .aspectRatio(16f / 9f),
                    )
                }
                Column(modifier = Modifier.padding(horizontal = 14.dp, vertical = 12.dp)) {
                    Text(
                        text = note.title,
                        style = MaterialTheme.typography.titleMedium,
                        fontWeight = FontWeight.Bold,
                        maxLines = 2,
                        overflow = TextOverflow.Ellipsis,
                        color = fg,
                    )
                    if (note.snippet.isNotBlank()) {
                        Spacer(Modifier.height(6.dp))
                        val annotated = remember(note.snippet, accent) {
                            renderPreviewAnnotated(note.snippet, accent)
                        }
                        // ClickableText is duurder dan Text. maxLines van 8 naar 5
                        // verlaagt de text-layout-cost merkbaar voor lange snippets.
                        ClickableText(
                            text = annotated,
                            style = snippetStyle,
                            maxLines = 5,
                            overflow = TextOverflow.Ellipsis,
                            onClick = { offset ->
                                val urlAnn = annotated
                                    .getStringAnnotations(tag = "URL", start = offset, end = offset)
                                    .firstOrNull()
                                if (urlAnn != null) {
                                    onUrlClick(urlAnn.item)
                                } else {
                                    onClick()
                                }
                            },
                        )
                    }
                    if (note.meta.tags.isNotEmpty()) {
                        Spacer(Modifier.height(8.dp))
                        TagChips(note.meta.tags, foreground = fg)
                    }
                    Spacer(Modifier.height(8.dp))
                    Text(
                        text = timestampText,
                        style = labelStyle,
                        color = timestampColor,
                    )
                }
            }
            if (note.meta.pinned) {
                IconButton(
                    onClick = onPinClick,
                    modifier = Modifier
                        .align(Alignment.TopEnd)
                        .padding(4.dp)
                        .size(28.dp),
                ) {
                    Icon(
                        Icons.Filled.PushPin,
                        contentDescription = stringResource(R.string.action_unpin),
                        tint = fg,
                    )
                }
            }
        }
    }
}

@Composable
private fun TagChips(tags: List<String>, foreground: Color) {
    Box {
        Column {
            // Eenvoudige flow zonder externe lib: één regel chips per regel.
            // Korte tag-lijsten passen meestal op één regel; lange wrappen naar
            // volgende regels via Compose's default wrap-gedrag in Column.
            val rows = chunkTagsForRow(tags)
            for (row in rows) {
                androidx.compose.foundation.layout.Row(
                    horizontalArrangement = Arrangement.spacedBy(4.dp),
                ) {
                    for (tag in row) {
                        TagChip(tag, foreground)
                    }
                }
                Spacer(Modifier.height(4.dp))
            }
        }
    }
}

private fun chunkTagsForRow(tags: List<String>): List<List<String>> {
    // Verdeel in groepjes van max 3 zodat ze meestal op één regel passen.
    if (tags.isEmpty()) return emptyList()
    val perRow = 3
    return tags.chunked(perRow)
}

@Composable
private fun TagChip(tag: String, foreground: Color) {
    Surface(
        color = foreground.copy(alpha = 0.10f),
        contentColor = foreground,
        shape = RoundedCornerShape(10.dp),
    ) {
        Text(
            text = "#$tag",
            style = MaterialTheme.typography.labelSmall.copy(fontWeight = FontWeight.Medium),
            modifier = Modifier.padding(horizontal = 7.dp, vertical = 2.dp),
        )
    }
}

@Composable
private fun CenteredText(text: String) {
    Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Text(text, style = MaterialTheme.typography.bodyMedium)
    }
}

@Composable
private fun EmptyState(text: String, actionLabel: String, onAction: () -> Unit) {
    Box(modifier = Modifier.fillMaxSize().padding(24.dp), contentAlignment = Alignment.Center) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Text(text, style = MaterialTheme.typography.bodyMedium)
            Spacer(Modifier.height(16.dp))
            Button(onClick = onAction) { Text(actionLabel) }
        }
    }
}

private fun formatTimestamp(epochMillis: Long): String {
    if (epochMillis <= 0) return ""
    // SECOND_IN_MILLIS-resolutie: kaarten van seconden geleden krijgen niet allemaal
    // hetzelfde "X min ago"-label.
    return DateUtils.getRelativeTimeSpanString(
        epochMillis,
        System.currentTimeMillis(),
        DateUtils.SECOND_IN_MILLIS,
        DateUtils.FORMAT_ABBREV_RELATIVE,
    ).toString()
}

internal fun noteBackground(color: NoteColor, darkTheme: Boolean): Color {
    val palette = if (darkTheme) Palette.dark else Palette.light
    return palette[color] ?: palette[NoteColor.DEFAULT]!!
}

internal fun contentColorOn(color: NoteColor, darkTheme: Boolean): Color {
    if (color == NoteColor.DEFAULT) {
        return if (darkTheme) Color(0xFFE6E1D6) else Color(0xFF1F1F1F)
    }
    // Pastel achtergrond: gebruik bijna-zwart op licht, bijna-wit op donker.
    return if (darkTheme) Color(0xFFEFEFEF) else Color(0xFF1A1A1A)
}

internal fun accentOn(color: NoteColor, foreground: Color): Color {
    // Voor wiki-links: gebruik een opvallende variant van de forground-kleur.
    return if (color == NoteColor.DEFAULT) {
        Color(0xFFC2185B) // magenta-accent, matcht het nieuwe sunset-thema
    } else {
        foreground
    }
}

/**
 * Rendert een preview waarbij `[[link]]` / `[[link|alias]]` onderstreept worden,
 * en zowel `[label](url)` als losse http(s)-URL's met een `"URL"`-string-annotation
 * gemarkeerd worden zodat ClickableText ze als kliktarget kan herkennen.
 */
internal fun renderPreviewAnnotated(
    text: String,
    accent: Color,
): androidx.compose.ui.text.AnnotatedString {
    data class Match(val start: Int, val end: Int, val display: String, val href: String?)

    // Checklist-syntax (`- [ ]` / `- [x]`) wordt voor de preview vervangen door
    // unicode-glyphs. Vorm-gebaseerd (leeg vs. gevuld), dus ook leesbaar zonder
    // kleur — past bij de UI-richtlijn dat we niet alleen op kleur leunen.
    val source = text
        .replace(Regex("(?m)^- \\[ \\] "), "☐ ")
        .replace(Regex("(?m)^- \\[[xX]\\] "), "☑ ")

    val wikiRegex = Regex("\\[\\[([^\\]\\|\\n]+)(?:\\|([^\\]\\n]+))?\\]\\]")
    val mdRegex = Regex("\\[([^\\]\\n]+)\\]\\((https?://[^)\\s]+)\\)")
    val urlRegex = Regex("https?://\\S+")

    val matches = mutableListOf<Match>()
    for (m in wikiRegex.findAll(source)) {
        val target = m.groupValues[1].trim()
        val alias = m.groupValues.getOrNull(2)?.trim().orEmpty()
        val display = alias.ifEmpty { target }
        matches.add(Match(m.range.first, m.range.last + 1, display, null))
    }
    for (m in mdRegex.findAll(source)) {
        val label = m.groupValues[1].trim()
        val url = m.groupValues[2].trim().trimEnd('.', ',', ';', ':', '!', '?')
        matches.add(Match(m.range.first, m.range.last + 1, label, url))
    }
    for (m in urlRegex.findAll(source)) {
        val overlap = matches.any { m.range.first >= it.start && m.range.first < it.end }
        if (overlap) continue
        val raw = m.value
        val trail = raw.takeLastWhile { it in ".,;:!?)]\"'" }.length
        val clean = raw.dropLast(trail)
        if (clean.isEmpty()) continue
        matches.add(Match(m.range.first, m.range.first + clean.length, clean, clean))
    }
    matches.sortBy { it.start }

    return buildAnnotatedString {
        var i = 0
        for (m in matches) {
            if (m.start < i) continue // overlappende match, sla over
            if (m.start > i) append(source.substring(i, m.start))
            if (m.href != null) {
                pushStringAnnotation(tag = "URL", annotation = m.href)
                withStyle(
                    SpanStyle(
                        color = accent,
                        textDecoration = TextDecoration.Underline,
                        fontWeight = FontWeight.Medium,
                    )
                ) {
                    append(m.display)
                }
                pop()
            } else {
                withStyle(
                    SpanStyle(
                        color = accent,
                        textDecoration = TextDecoration.Underline,
                        fontWeight = FontWeight.Medium,
                    )
                ) {
                    append(m.display)
                }
            }
            i = m.end
        }
        if (i < source.length) append(source.substring(i))
    }
}

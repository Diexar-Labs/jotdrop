package com.diexar.keepcapture

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Bundle
import android.text.format.DateUtils
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.core.content.ContextCompat
import androidx.core.splashscreen.SplashScreen.Companion.installSplashScreen
import androidx.preference.PreferenceManager
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.FileProvider
import java.io.File
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.tween
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
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.lazy.staggeredgrid.LazyVerticalStaggeredGrid
import androidx.compose.foundation.lazy.staggeredgrid.StaggeredGridCells
import androidx.compose.foundation.lazy.staggeredgrid.StaggeredGridItemSpan
import androidx.compose.foundation.lazy.staggeredgrid.items
import androidx.compose.foundation.text.ClickableText
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.AddAPhoto
import androidx.compose.material.icons.filled.Archive
import androidx.compose.material.icons.filled.CameraAlt
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.DoneAll
import androidx.compose.material.icons.filled.GraphicEq
import androidx.compose.material.icons.filled.Image
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.SystemUpdate
import androidx.compose.material.icons.filled.Done
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.PushPin
import androidx.compose.material.icons.outlined.PushPin
import androidx.compose.material.icons.filled.RadioButtonUnchecked
import androidx.compose.material.icons.filled.Repeat
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Stop
import androidx.compose.material.icons.filled.TextFields
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.TextButton
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.FilterChipDefaults
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.SmallFloatingActionButton
import androidx.compose.material3.rememberModalBottomSheetState
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
import androidx.compose.runtime.LaunchedEffect
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
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.lifecycle.lifecycleScope
import coil.compose.AsyncImage
import coil.request.ImageRequest
import java.text.SimpleDateFormat
import java.util.Locale
import com.diexar.keepcapture.ui.JotDropTheme
import com.diexar.keepcapture.ui.noteCardBrush
import com.diexar.keepcapture.ui.screenBackgroundBrush
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.sync.withLock
import androidx.compose.foundation.MutatePriority
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.lazy.staggeredgrid.LazyStaggeredGridState
import androidx.compose.foundation.lazy.staggeredgrid.rememberLazyStaggeredGridState
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.automirrored.filled.Sort
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.input.pointer.changedToUpIgnoreConsumed
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.pointer.positionChange
import androidx.compose.ui.zIndex
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.withTimeoutOrNull
import kotlin.math.roundToInt

class NotesListActivity : ComponentActivity() {

    private val notesState = MutableStateFlow<NotesUiState>(NotesUiState.Loading)
    private var stateEpoch = 0L
    private var pendingCameraUri: Uri? = null
    private var pendingCameraFile: File? = null
    // OCR-modus blijft staan tot de capture-flow afgerond is. Met deze flag weet
    // de result-callback of er na de copy ook nog OCR moet draaien.
    private var pendingOcr: Boolean = false

    // Sorteermodus (newest/manual), gepersisteerd in prefs. Gedeeld met Compose
    // zodat de top-bar het actieve vinkje kan tonen en de grid weet of slepen aan staat.
    private val sortModeFlow = MutableStateFlow(NoteSortMode.NEWEST)

    // Voicememo-state — gedeeld met Compose via StateFlow zodat de FAB van
    // icoon kan wisselen (mic ↔ stop) en de confirm-dialog open kan klappen.
    private val isRecording = MutableStateFlow(false)
    private val pendingMemo = MutableStateFlow<VoiceMemoRecorder.RecordedMemo?>(null)
    private val recorder by lazy { VoiceMemoRecorder(applicationContext) }

    private val recordPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { granted ->
        if (granted) {
            beginRecording()
        } else {
            Toast.makeText(this, R.string.record_permission_denied, Toast.LENGTH_SHORT).show()
        }
    }

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
        installSplashScreen()
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        sortModeFlow.value = Storage.getSortMode(this)
        setContent {
            JotDropTheme {
                NotesListScreen(
                    stateFlow = notesState.asStateFlow(),
                    sortModeFlow = sortModeFlow.asStateFlow(),
                    onRefresh = { reload(rescheduleReminders = true) },
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
                    isRecordingFlow = isRecording.asStateFlow(),
                    pendingMemoFlow = pendingMemo.asStateFlow(),
                    onToggleRecord = { handleRecordToggle() },
                    onSaveMemo = { memo -> saveMemo(memo) },
                    onDiscardMemo = { discardPendingMemo() },
                    onOpenNote = { note, orderedUris ->
                        startActivity(EditorActivity.openNoteIntent(
                            this, note.uri, orderedUris, note.thumbnailBasename, note.thumbnailUri,
                        ))
                    },
                    onTogglePin = { note ->
                        togglePin(note)
                    },
                    onToggleChecklist = { note, index ->
                        toggleChecklist(note, index)
                    },
                    onSetSortMode = { mode -> setSortMode(mode) },
                    onMoveNote = { moved, finalOrder -> moveNote(moved, finalOrder) },
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
        stateEpoch++
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
        reload(rescheduleReminders = true)
    }

    private fun reload(rescheduleReminders: Boolean = false) {
        if (Storage.getVaultUri(this) == null) {
            notesState.value = NotesUiState.NoVault
            return
        }
        val requestEpoch = ++stateEpoch
        if (notesState.value !is NotesUiState.Loaded) notesState.value = NotesUiState.Loading
        lifecycleScope.launch {
            val result = withContext(Dispatchers.IO) {
                val loaded = Storage.listNotes(this@NotesListActivity)
                if (rescheduleReminders && loaded.isSuccess &&
                    ReminderScheduler.rescheduleAll(this@NotesListActivity, loaded.getOrThrow())) {
                    Storage.listNotes(this@NotesListActivity)
                } else loaded
            }
            if (requestEpoch != stateEpoch) return@launch
            notesState.value = result.fold(
                onSuccess = { NotesUiState.Loaded(sortNotes(it, sortModeFlow.value)) },
                onFailure = { NotesUiState.Error(it.message ?: getString(R.string.error_unknown)) },
            )
        }
    }

    private fun setSortMode(mode: NoteSortMode) {
        sortModeFlow.value = mode
        Storage.saveSortMode(this, mode)
        val loaded = notesState.value as? NotesUiState.Loaded
        if (loaded != null) notesState.value = NotesUiState.Loaded(sortNotes(loaded.notes, mode)) else reload()
    }

    private fun updateLoadedNotes(change: (List<NoteSummary>) -> List<NoteSummary>) {
        val loaded = notesState.value as? NotesUiState.Loaded
        if (loaded != null) {
            stateEpoch++
            notesState.value = NotesUiState.Loaded(sortNotes(change(loaded.notes), sortModeFlow.value))
        } else reload()
    }

    private fun moveNote(moved: NoteSummary, finalOrder: List<NoteSummary>) {
        stateEpoch++
        lifecycleScope.launch {
            val result = withContext(Dispatchers.IO) {
                Storage.noteWriteMutex.withLock {
                    Storage.applyManualOrder(this@NotesListActivity, moved, finalOrder)
                }
            }
            result.onSuccess { assignments ->
                updateLoadedNotes { notes -> notes.map { note ->
                    val order = assignments[note.uri.toString()]
                    if (order != null) note.copy(meta = note.meta.copy(order = order))
                    else note
                } }
            }.onFailure { err ->
                Toast.makeText(
                    this@NotesListActivity,
                    err.message ?: getString(R.string.error_generic),
                    Toast.LENGTH_SHORT,
                ).show()
                reload()
            }
        }
    }

    private fun handleRecordToggle() {
        if (!requireVaultOrPromptSettings()) return
        if (isRecording.value) {
            stopAndShowConfirm()
            return
        }
        if (pendingMemo.value != null) return // confirm-dialog staat al open
        val granted = ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) ==
            PackageManager.PERMISSION_GRANTED
        if (granted) {
            beginRecording()
        } else {
            recordPermissionLauncher.launch(Manifest.permission.RECORD_AUDIO)
        }
    }

    private fun beginRecording() {
        recorder.start().onSuccess {
            isRecording.value = true
        }.onFailure { err ->
            Toast.makeText(
                this,
                getString(R.string.record_start_failed, err.message ?: err.javaClass.simpleName),
                Toast.LENGTH_SHORT,
            ).show()
        }
    }

    private fun stopAndShowConfirm() {
        isRecording.value = false
        recorder.stopAndFinalize().onSuccess { memo ->
            pendingMemo.value = memo
        }.onFailure { err ->
            Toast.makeText(
                this,
                getString(R.string.record_too_short, err.message ?: err.javaClass.simpleName),
                Toast.LENGTH_SHORT,
            ).show()
        }
    }

    private fun saveMemo(memo: VoiceMemoRecorder.RecordedMemo) {
        pendingMemo.value = null
        stateEpoch++
        lifecycleScope.launch {
            val result = withContext(Dispatchers.IO) {
                Storage.saveVoiceMemoNote(this@NotesListActivity, memo.file, memo.durationMs)
            }
            result.onSuccess { filename ->
                Toast.makeText(
                    this@NotesListActivity,
                    getString(R.string.toast_saved, filename),
                    Toast.LENGTH_SHORT,
                ).show()
                reload()
            }.onFailure { err ->
                memo.file.delete()
                Toast.makeText(
                    this@NotesListActivity,
                    getString(R.string.toast_error, err.message ?: "onbekende fout"),
                    Toast.LENGTH_SHORT,
                ).show()
            }
        }
    }

    private fun discardPendingMemo() {
        pendingMemo.value?.file?.delete()
        pendingMemo.value = null
    }

    override fun onStop() {
        // Veilig opruimen als gebruiker tijdens opname de app verlaat — voorkomt
        // dat de mic vast blijft staan voor andere apps.
        if (isRecording.value) {
            recorder.discard()
            isRecording.value = false
        }
        super.onStop()
    }

    private fun togglePin(note: NoteSummary) {
        stateEpoch++
        lifecycleScope.launch {
            val newMeta = note.meta.copy(pinned = !note.meta.pinned)
            val result = withContext(Dispatchers.IO) {
                Storage.noteWriteMutex.withLock {
                    Storage.updateNoteMeta(this@NotesListActivity, note.uri, newMeta)
                        .map { Storage.lastModified(this@NotesListActivity, note.uri, note.lastModified) }
                }
            }
            result.onSuccess { lastModified ->
                updateLoadedNotes { notes -> notes.map {
                    if (it.uri == note.uri) it.copy(
                        meta = newMeta,
                        lastModified = lastModified,
                    )
                    else it
                } }
            }.onFailure { err ->
                Toast.makeText(this@NotesListActivity, err.message ?: getString(R.string.error_generic), Toast.LENGTH_SHORT).show()
            }
        }
    }

    private fun toggleChecklist(note: NoteSummary, index: Int) {
        stateEpoch++
        lifecycleScope.launch {
            val result = withContext(Dispatchers.IO) {
                Storage.noteWriteMutex.withLock {
                    Storage.toggleChecklistItem(this@NotesListActivity, note.uri, index).map {
                        Storage.refreshNoteSummary(this@NotesListActivity, note)
                    }
                }
            }
            result.onSuccess { updated ->
                if (updated == null) reload()
                else updateLoadedNotes { notes -> notes.map { if (it.uri == note.uri) updated else it } }
            }.onFailure { err ->
                Toast.makeText(
                    this@NotesListActivity,
                    err.message ?: getString(R.string.error_generic),
                    Toast.LENGTH_SHORT,
                ).show()
            }
        }
    }
}

/**
 * Wegklikbare balk bovenaan het dashboard die meldt dat er een nieuwere release
 * is. Toont een update-icoon + tekst (niet alleen kleur — kleurenblind-veilig),
 * een "Bekijken"-knop naar de release-pagina en een ×-knop om te negeren.
 */
@Composable
private fun UpdateBanner(version: String, onView: () -> Unit, onDismiss: () -> Unit) {
    Surface(
        color = MaterialTheme.colorScheme.secondaryContainer,
        contentColor = MaterialTheme.colorScheme.onSecondaryContainer,
        shape = RoundedCornerShape(10.dp),
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 10.dp, vertical = 6.dp),
    ) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            modifier = Modifier.padding(start = 12.dp, top = 4.dp, end = 4.dp, bottom = 4.dp),
        ) {
            Icon(Icons.Filled.SystemUpdate, contentDescription = null)
            Text(
                text = stringResource(R.string.update_available, version),
                style = MaterialTheme.typography.bodyMedium,
                modifier = Modifier.weight(1f),
            )
            TextButton(onClick = onView) { Text(stringResource(R.string.update_view)) }
            IconButton(onClick = onDismiss) {
                Icon(Icons.Filled.Close, contentDescription = stringResource(R.string.update_dismiss))
            }
        }
    }
}

/**
 * Recycling-hint voor de LazyGrid: kaarten met dezelfde lay-out-vorm
 * (thumbnail / audio-banner / alleen tekst) hergebruiken elkaars compositie
 * tijdens scroll, wat het stotteren bij veel kaarten vermindert.
 */
private fun noteContentType(note: NoteSummary): String = when {
    note.thumbnailUri != null -> "thumb"
    note.audioBasename != null -> "audio"
    else -> "text"
}

private fun sortNotes(notes: List<NoteSummary>, mode: NoteSortMode): List<NoteSummary> {
    // Eén format-instantie, key vooraf berekend (SimpleDateFormat is niet
    // thread-safe en parse() is relatief duur in een comparator).
    val fmt = SimpleDateFormat("yyyy-MM-dd HHmmss", Locale.US)
    return notes
        .map { it to rankForSort(it, fmt, mode) }
        .sortedWith(
            // Gepind eerst, daarna oplopende rang. Bij gelijke rang breekt de
            // deterministische bestandsnaam de gelijkstand.
            compareByDescending<Pair<NoteSummary, Double>> { it.first.meta.pinned }
                .thenBy { it.second }
                .thenBy { it.first.filename }
        )
        .map { it.first }
}

private fun rankForSort(note: NoteSummary, fmt: SimpleDateFormat, mode: NoteSortMode): Double {
    return when (mode) {
        NoteSortMode.NEWEST -> -NoteOrder.noteCreatedMs(note.filename, note.lastModified, fmt).toDouble()
        NoteSortMode.MANUAL -> NoteOrder.manualRank(note.meta.order, note.filename)
    }
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
    sortModeFlow: StateFlow<NoteSortMode>,
    onRefresh: () -> Unit,
    onOpenSettings: () -> Unit,
    onNewNote: () -> Unit,
    onTakePhoto: () -> Unit,
    onPickPhoto: () -> Unit,
    onOcrCamera: () -> Unit,
    onOcrGallery: () -> Unit,
    isRecordingFlow: StateFlow<Boolean>,
    pendingMemoFlow: StateFlow<VoiceMemoRecorder.RecordedMemo?>,
    onToggleRecord: () -> Unit,
    onSaveMemo: (VoiceMemoRecorder.RecordedMemo) -> Unit,
    onDiscardMemo: () -> Unit,
    onOpenNote: (NoteSummary, List<Uri>) -> Unit,
    onTogglePin: (NoteSummary) -> Unit,
    onToggleChecklist: (NoteSummary, Int) -> Unit,
    onSetSortMode: (NoteSortMode) -> Unit,
    onMoveNote: (NoteSummary, List<NoteSummary>) -> Unit,
) {
    val isRecording by isRecordingFlow.collectAsState()
    val pendingMemo by pendingMemoFlow.collectAsState()
    val state by stateFlow.collectAsState()
    val sortMode by sortModeFlow.collectAsState()
    val snackbarHostState = remember { SnackbarHostState() }
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    val prefs = remember(context) { PreferenceManager.getDefaultSharedPreferences(context) }
    val isPlayInstall = remember(context) { UpdateChecker.isPlayInstall(context) }
    var showTesterInvite by remember { mutableStateOf(!isPlayInstall && !prefs.getBoolean("play_tester_live_invite_seen", false)) }
    val dismissTesterInvite: () -> Unit = {
        prefs.edit().putBoolean("play_tester_live_invite_seen", true).apply()
        showTesterInvite = false
    }
    val openTesterLink: (String) -> Unit = { url ->
        try {
            context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
        } catch (e: Exception) {
            Toast.makeText(context, context.getString(R.string.toast_error, e.message ?: ""), Toast.LENGTH_SHORT).show()
        }
    }
    val openLinkLabel = stringResource(R.string.action_open_link)
    val dark = isSystemInDarkTheme()
    val bgBrush = remember(dark) { screenBackgroundBrush(dark) }
    var searchQuery by remember { mutableStateOf("") }
    var selectedTags by remember { mutableStateOf<Set<String>>(emptySet()) }
    var tagSheetOpen by remember { mutableStateOf(false) }
    var selectionMode by remember { mutableStateOf(false) }
    var selectedNoteUris by remember { mutableStateOf<Set<Uri>>(emptySet()) }
    var showBulkArchiveDialog by remember { mutableStateOf(false) }
    var showBulkDeleteDialog by remember { mutableStateOf(false) }
    var updateInfo by remember { mutableStateOf<UpdateInfo?>(null) }
    var overflowOpen by remember { mutableStateOf(false) }
    var sortMenuOpen by remember { mutableStateOf(false) }

    // Eenmalige, throttled update-check (max 1x/dag) bij openen van het dashboard.
    // Banner verschijnt alleen als de gevonden versie niet eerder is weggetikt.
    LaunchedEffect(Unit) {
        val info = UpdateChecker.check(context, force = false)
        if (info != null && !UpdateChecker.isDismissed(context, info.version)) {
            updateInfo = info
        }
    }

    // Bron-notities + afgeleiden — gelift uit de Loaded-tak zodat de selection
    // top-bar (op Scaffold-niveau) toegang heeft tot het gefilterde aantal voor
    // "Alles selecteren".
    val loadedNotes = (state as? NotesUiState.Loaded)?.notes.orEmpty()
    val tagsByFrequency = remember(loadedNotes) {
        loadedNotes.flatMap { it.meta.tags }
            .groupingBy { it }.eachCount()
            .entries
            .sortedWith(
                compareByDescending<Map.Entry<String, Int>> { it.value }
                    .thenBy { it.key.lowercase() }
            )
            .map { it.key }
    }
    val allTagsAlpha = remember(loadedNotes) {
        loadedNotes.flatMap { it.meta.tags }.distinct().sortedBy { it.lowercase() }
    }
    val visibleTags = remember(tagsByFrequency, selectedTags) {
        val top = tagsByFrequency.take(TAG_CHIPS_TOP_N)
        val extraSelected = selectedTags.filter { it !in top }.sortedBy { it.lowercase() }
        (top + extraSelected).distinct()
    }
    val overflowCount = (tagsByFrequency.size - visibleTags.size).coerceAtLeast(0)
    val filtered = remember(loadedNotes, searchQuery, selectedTags) {
        if (loadedNotes.isEmpty()) emptyList()
        else applyFilters(loadedNotes, searchQuery, selectedTags)
    }

    // Selection-helpers — gewone lambdas (geen @Composable) zodat ze in callbacks/
    // dialog-onConfirm-handlers gebruikt kunnen worden.
    val exitSelection: () -> Unit = {
        selectionMode = false
        selectedNoteUris = emptySet()
    }
    val toggleSelect: (Uri) -> Unit = { uri ->
        val newSet = if (uri in selectedNoteUris) selectedNoteUris - uri else selectedNoteUris + uri
        selectedNoteUris = newSet
        if (newSet.isEmpty()) selectionMode = false
    }
    val enterSelection: (Uri) -> Unit = { uri ->
        selectionMode = true
        selectedNoteUris = setOf(uri)
    }
    val selectAll: () -> Unit = {
        selectedNoteUris = filtered.map { it.uri }.toSet()
    }
    val onCardClick: (NoteSummary) -> Unit = { note ->
        if (selectionMode) {
            toggleSelect(note.uri)
        } else {
            // Kaartvolgorde zoals het grid rendert (gepind eerst, dan de rest) —
            // daarmee kan de editor naar de vorige/volgende notitie navigeren.
            val ordered = filtered.filter { it.meta.pinned } + filtered.filter { !it.meta.pinned }
            onOpenNote(note, ordered.map { it.uri })
        }
    }
    val onCardLongClick: (NoteSummary) -> Unit = { note ->
        if (selectionMode) toggleSelect(note.uri) else enterSelection(note.uri)
    }

    // BackHandler: in selection-mode vangt back-button af om uit te stappen
    // in plaats van naar het systeem-home-scherm te gaan.
    BackHandler(enabled = selectionMode) { exitSelection() }

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
            if (selectionMode) {
                SelectionTopBar(
                    selectedCount = selectedNoteUris.size,
                    canSelectAll = selectedNoteUris.size < filtered.size,
                    canBulkAct = selectedNoteUris.isNotEmpty(),
                    onExit = exitSelection,
                    onSelectAll = selectAll,
                    onArchive = { showBulkArchiveDialog = true },
                    onDelete = { showBulkDeleteDialog = true },
                )
            } else {
                TopAppBar(
                    title = {
                        Text(
                            stringResource(R.string.app_name),
                            style = MaterialTheme.typography.titleLarge,
                            fontWeight = FontWeight.SemiBold,
                        )
                    },
                    actions = {
                        Box {
                            IconButton(onClick = { sortMenuOpen = true }) {
                                Icon(Icons.AutoMirrored.Filled.Sort, contentDescription = stringResource(R.string.sort_title))
                            }
                            DropdownMenu(
                                expanded = sortMenuOpen,
                                onDismissRequest = { sortMenuOpen = false },
                            ) {
                                DropdownMenuItem(
                                    text = { Text(stringResource(R.string.sort_newest)) },
                                    leadingIcon = {
                                        if (sortMode == NoteSortMode.NEWEST) {
                                            Icon(Icons.Filled.Check, contentDescription = null)
                                        }
                                    },
                                    onClick = {
                                        sortMenuOpen = false
                                        onSetSortMode(NoteSortMode.NEWEST)
                                    },
                                )
                                DropdownMenuItem(
                                    text = { Text(stringResource(R.string.sort_manual)) },
                                    leadingIcon = {
                                        if (sortMode == NoteSortMode.MANUAL) {
                                            Icon(Icons.Filled.Check, contentDescription = null)
                                        }
                                    },
                                    onClick = {
                                        sortMenuOpen = false
                                        onSetSortMode(NoteSortMode.MANUAL)
                                    },
                                )
                            }
                        }
                        IconButton(onClick = onOpenSettings) {
                            Icon(Icons.Filled.Settings, contentDescription = stringResource(R.string.action_settings))
                        }
                        Box {
                            IconButton(onClick = { overflowOpen = true }) {
                                Icon(Icons.Filled.MoreVert, contentDescription = stringResource(R.string.more_options))
                            }
                            DropdownMenu(
                                expanded = overflowOpen,
                                onDismissRequest = { overflowOpen = false },
                            ) {
                                DropdownMenuItem(
                                    text = { Text(stringResource(R.string.play_tester_menu)) },
                                    onClick = {
                                        overflowOpen = false
                                        showTesterInvite = true
                                    },
                                )
                                DropdownMenuItem(
                                    text = { Text(stringResource(R.string.update_check)) },
                                    leadingIcon = { Icon(Icons.Filled.SystemUpdate, contentDescription = null) },
                                    onClick = {
                                        overflowOpen = false
                                        scope.launch {
                                            if (isPlayInstall) {
                                                try {
                                                    context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("https://play.google.com/store/apps/details?id=com.diexar.keepcapture")))
                                                } catch (e: Exception) {
                                                    snackbarHostState.showSnackbar(context.getString(R.string.toast_error, e.message ?: ""))
                                                }
                                                return@launch
                                            }
                                            val info = UpdateChecker.check(context, force = true)
                                            if (info != null) {
                                                updateInfo = info
                                            } else {
                                                snackbarHostState.showSnackbar(
                                                    context.getString(
                                                        R.string.update_up_to_date,
                                                        UpdateChecker.installedVersion(context) ?: "",
                                                    )
                                                )
                                            }
                                        }
                                    },
                                )
                            }
                        }
                    },
                    colors = TopAppBarDefaults.topAppBarColors(
                        containerColor = Color.Transparent,
                        scrolledContainerColor = Color.Transparent,
                    ),
                )
            }
        },
        floatingActionButton = {
            Column(horizontalAlignment = Alignment.End) {
                // Voicememo-knop bovenaan de stack. Tijdens opname switcht het
                // icoon naar Stop + krijgt een rode container — vormverschil
                // (mic ↔ stop) is de primaire feedback, niet alleen kleur.
                // In idle-state pakken we de FAB-default (primaryContainer) zodat
                // de mic-knop dezelfde kleur heeft als de foto- en plus-FAB.
                SmallFloatingActionButton(
                    onClick = onToggleRecord,
                    containerColor = if (isRecording) {
                        MaterialTheme.colorScheme.errorContainer
                    } else {
                        MaterialTheme.colorScheme.primaryContainer
                    },
                    contentColor = if (isRecording) {
                        MaterialTheme.colorScheme.onErrorContainer
                    } else {
                        MaterialTheme.colorScheme.onPrimaryContainer
                    },
                ) {
                    Icon(
                        imageVector = if (isRecording) Icons.Filled.Stop else Icons.Filled.Mic,
                        contentDescription = stringResource(
                            if (isRecording) R.string.action_stop_recording else R.string.action_start_recording
                        ),
                    )
                }
                Spacer(Modifier.height(12.dp))
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
                NotesUiState.Loading -> LoadingSpinner()
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
                        Column(modifier = Modifier.fillMaxSize()) {
                            updateInfo?.let { info ->
                                UpdateBanner(
                                    version = info.version,
                                    onView = {
                                        context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(info.url)))
                                    },
                                    onDismiss = {
                                        UpdateChecker.dismiss(context, info.version)
                                        updateInfo = null
                                    },
                                )
                            }
                            SearchAndFilterBar(
                                query = searchQuery,
                                onQueryChange = { searchQuery = it },
                                visibleTags = visibleTags,
                                selectedTags = selectedTags,
                                overflowCount = overflowCount,
                                onTagToggle = { tag ->
                                    selectedTags = if (tag in selectedTags) selectedTags - tag else selectedTags + tag
                                },
                                onClearTags = { selectedTags = emptySet() },
                                onShowAllTags = { tagSheetOpen = true },
                            )
                            // weight(1f) zorgt dat de grid (of "no-results"-state) de rest
                            // van de hoogte krijgt naast de bar bovenin — anders raakt de
                            // verticale layout in de knoop.
                            Box(modifier = Modifier.weight(1f).fillMaxWidth()) {
                                if (filtered.isEmpty()) {
                                    CenteredText(stringResource(R.string.empty_no_results))
                                } else {
                                    NotesGrid(
                                        notes = filtered,
                                        selectionMode = selectionMode,
                                        selectedUris = selectedNoteUris,
                                        manualMode = sortMode == NoteSortMode.MANUAL,
                                        onCardClick = onCardClick,
                                        onCardLongClick = onCardLongClick,
                                        onTogglePin = onTogglePin,
                                        onToggleChecklist = onToggleChecklist,
                                        onUrlClick = onUrlClick,
                                        onMoveNote = onMoveNote,
                                    )
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    if (showTesterInvite && state is NotesUiState.Loaded && !selectionMode && pendingMemo == null) {
        AlertDialog(
            onDismissRequest = dismissTesterInvite,
            title = { Text(stringResource(R.string.play_tester_title)) },
            text = {
                Column(Modifier.verticalScroll(rememberScrollState())) {
                    Text(stringResource(R.string.play_tester_message))
                    TextButton(onClick = {
                        openTesterLink("https://accounts.google.com/ServiceLogin?continue=https%3A%2F%2Fgroups.google.com%2Fg%2Fjotdrop-play-testers%2Fabout")
                    }) { Text(stringResource(R.string.play_tester_join)) }
                    TextButton(onClick = {
                        openTesterLink("https://play.google.com/apps/testing/com.diexar.keepcapture")
                    }) { Text(stringResource(R.string.play_tester_download)) }
                }
            },
            confirmButton = {
                TextButton(onClick = dismissTesterInvite) { Text(stringResource(R.string.play_tester_later)) }
            },
            dismissButton = {
                TextButton(onClick = {
                    openTesterLink("https://github.com/Diexar-Labs/jotdrop#help-test-jotdrop-on-google-play")
                }) { Text(stringResource(R.string.play_tester_help)) }
            },
        )
    }
    if (tagSheetOpen) {
        TagPickerSheet(
            allTags = allTagsAlpha,
            selectedTags = selectedTags,
            onTagToggle = { tag ->
                selectedTags = if (tag in selectedTags) selectedTags - tag else selectedTags + tag
            },
            onDismiss = { tagSheetOpen = false },
        )
    }
    if (showBulkArchiveDialog) {
        AlertDialog(
            onDismissRequest = { showBulkArchiveDialog = false },
            title = { Text(stringResource(R.string.bulk_archive_title, selectedNoteUris.size)) },
            text = { Text(stringResource(R.string.bulk_archive_message)) },
            confirmButton = {
                TextButton(onClick = {
                    showBulkArchiveDialog = false
                    val toArchive = selectedNoteUris.toList()
                    scope.launch {
                        val (ok, fail) = bulkPerform(toArchive) { uri ->
                            ReminderScheduler.cancel(context, uri)
                            withContext(Dispatchers.IO) { Storage.archiveNote(context, uri) }
                        }
                        val msg = if (fail == 0) {
                            context.getString(R.string.toast_bulk_archived, ok)
                        } else {
                            context.getString(R.string.toast_bulk_partial, ok, fail)
                        }
                        Toast.makeText(context, msg, Toast.LENGTH_SHORT).show()
                        exitSelection()
                        onRefresh()
                    }
                }) {
                    Text(stringResource(R.string.action_archive))
                }
            },
            dismissButton = {
                TextButton(onClick = { showBulkArchiveDialog = false }) {
                    Text(stringResource(R.string.action_cancel))
                }
            },
        )
    }
    if (showBulkDeleteDialog) {
        AlertDialog(
            onDismissRequest = { showBulkDeleteDialog = false },
            title = { Text(stringResource(R.string.bulk_delete_title, selectedNoteUris.size)) },
            text = { Text(stringResource(R.string.bulk_delete_message)) },
            confirmButton = {
                TextButton(onClick = {
                    showBulkDeleteDialog = false
                    val toDelete = selectedNoteUris.toList()
                    scope.launch {
                        val (ok, fail) = bulkPerform(toDelete) { uri ->
                            ReminderScheduler.cancel(context, uri)
                            withContext(Dispatchers.IO) { Storage.deleteNote(context, uri) }
                        }
                        val msg = if (fail == 0) {
                            context.getString(R.string.toast_bulk_deleted, ok)
                        } else {
                            context.getString(R.string.toast_bulk_partial, ok, fail)
                        }
                        Toast.makeText(context, msg, Toast.LENGTH_SHORT).show()
                        exitSelection()
                        onRefresh()
                    }
                }) {
                    Text(stringResource(R.string.action_delete))
                }
            },
            dismissButton = {
                TextButton(onClick = { showBulkDeleteDialog = false }) {
                    Text(stringResource(R.string.action_cancel))
                }
            },
        )
    }

    pendingMemo?.let { memo ->
        val durationLabel = formatMemoDuration(memo.durationMs)
        AlertDialog(
            onDismissRequest = onDiscardMemo,
            title = { Text(stringResource(R.string.record_confirm_title)) },
            text = { Text(stringResource(R.string.record_confirm_message, durationLabel)) },
            confirmButton = {
                TextButton(onClick = { onSaveMemo(memo) }) {
                    Text(stringResource(R.string.action_save))
                }
            },
            dismissButton = {
                TextButton(onClick = onDiscardMemo) {
                    Text(stringResource(R.string.action_cancel))
                }
            },
        )
    }
    }
}

private fun formatMemoDuration(ms: Long): String {
    val totalSec = (ms / 1000).coerceAtLeast(0)
    return "%d:%02d".format(totalSec / 60, totalSec % 60)
}

/**
 * Sequentiële uitvoer van een suspend-bewerking op een lijst URIs. Geeft (ok, fail) terug.
 * Sequentieel ipv parallel omdat Storage's DocumentFile-IO door SAF heen niet altijd
 * thread-safe is — beter conservatief.
 */
private suspend fun bulkPerform(
    uris: List<Uri>,
    op: suspend (Uri) -> Result<Unit>,
): Pair<Int, Int> {
    var ok = 0
    var fail = 0
    for (uri in uris) {
        if (op(uri).isSuccess) ok++ else fail++
    }
    return ok to fail
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun NotesGrid(
    notes: List<NoteSummary>,
    selectionMode: Boolean,
    selectedUris: Set<Uri>,
    manualMode: Boolean,
    onCardClick: (NoteSummary) -> Unit,
    onCardLongClick: (NoteSummary) -> Unit,
    onTogglePin: (NoteSummary) -> Unit,
    onToggleChecklist: (NoteSummary, Int) -> Unit,
    onUrlClick: (String) -> Unit,
    onMoveNote: (NoteSummary, List<NoteSummary>) -> Unit,
) {
    val dark = isSystemInDarkTheme()
    // Vast 2 kolommen in portrait (Google Keep-style), 4 in landscape voor tablets/
    // brede telefoons in liggend. Geen Adaptive — consistente look ongeacht zoom.
    val isLandscape = LocalConfiguration.current.screenWidthDp >= 600
    val columnCount = if (isLandscape) 4 else 2

    val gridState = rememberLazyStaggeredGridState()
    val scope = rememberCoroutineScope()

    // Laat de grid staan tijdens de gesture: anders kan Compose de gesleepte
    // pointerInput afbreken terwijl de tekst tussen vaste kaartvakken wisselt.
    var ordered by remember(notes) { mutableStateOf(notes) }
    var pendingOrder by remember(notes) { mutableStateOf(notes) }
    var draggingUri by remember { mutableStateOf<Uri?>(null) }
    var dragOrigin by remember { mutableStateOf(IntOffset.Zero) }
    var dragSize by remember { mutableStateOf(IntSize.Zero) }
    var dragOffset by remember { mutableStateOf(Offset.Zero) }
    var dragFingerViewportX by remember { mutableStateOf(0f) }
    var dragFingerViewportY by remember { mutableStateOf(0f) }
    var autoScrollJob by remember { mutableStateOf<Job?>(null) }

    // De vinger in content-coördinaten: viewport-start + vingerpositie in de
    // viewport + opgebouwde beweging. Blijft kloppen terwijl autoscroll de
    // inhoud onder een stilstaande vinger doorschuift.
    fun fingerContentY(): Float =
        gridState.layoutInfo.viewportStartOffset + dragFingerViewportY + dragOffset.y
    fun fingerContentX(): Float = dragFingerViewportX + dragOffset.x

    fun recompute() {
        val uri = draggingUri ?: return
        val next = reorderForDrag(gridState, ordered, uri, fingerContentX(), fingerContentY())
        // Alleen herschrijven als de volgorde echt veranderde (geen zinloze
        // recomposities tijdens autoscroll).
        if (next.map { it.uri } != pendingOrder.map { it.uri }) {
            pendingOrder = next
        }
    }

    // Eén doorlopende autoscroll-loop voor de hele drag. Herberekent de
    // doelpositie na elke scrollstap, ook als de vinger stilstaat; stopt pas bij
    // drag-eind/cancel.
    fun startAutoScrollLoop() {
        autoScrollJob?.cancel()
        val edgeThreshold = 96f
        val scrollStep = 48f
        autoScrollJob = scope.launch {
            while (isActive) {
                val layout = gridState.layoutInfo
                val f = fingerContentY()
                val direction = when {
                    f < layout.viewportStartOffset + edgeThreshold -> -1f
                    f > layout.viewportEndOffset - edgeThreshold -> 1f
                    else -> 0f
                }
                if (direction != 0f) {
                    gridState.scroll(MutatePriority.Default) { scrollBy(direction * scrollStep) }
                    recompute()
                }
                delay(16)
            }
        }
    }

    val handleDragStart: (NoteSummary, Offset) -> Unit = { note, localOffset ->
        draggingUri = note.uri
        pendingOrder = ordered
        val layout = gridState.layoutInfo
        val info = layout.visibleItemsInfo.firstOrNull { (it.key as? String) == noteKey(note) }
        dragOrigin = info?.offset ?: IntOffset.Zero
        dragSize = info?.size ?: IntSize.Zero
        dragFingerViewportX = (info?.offset?.x ?: 0) + localOffset.x
        dragFingerViewportY = if (info != null) {
            info.offset.y - layout.viewportStartOffset + localOffset.y
        } else 0f
        dragOffset = Offset.Zero
        startAutoScrollLoop()
    }
    val handleDragMove: (NoteSummary, Offset) -> Unit = { _, total ->
        dragOffset = total
        recompute()
    }
    val handleDragEnd: (NoteSummary) -> Unit = { note ->
        autoScrollJob?.cancel()
        autoScrollJob = null
        draggingUri = null
        val finalOrder = pendingOrder
        if (finalOrder.map { it.uri } != ordered.map { it.uri }) {
            ordered = finalOrder
            onMoveNote(note, finalOrder)
        }
    }
    val handleDragCancel: () -> Unit = {
        autoScrollJob?.cancel()
        autoScrollJob = null
        draggingUri = null
        pendingOrder = ordered
    }

    val draggedNote = ordered.firstOrNull { it.uri == draggingUri }
    val targetIndex = pendingOrder.indexOfFirst { it.uri == draggingUri }
    val dropTarget = if (targetIndex >= 0 && pendingOrder.map { it.uri } != ordered.map { it.uri }) {
        ordered.getOrNull(targetIndex)?.uri
    } else null
    val density = LocalDensity.current
    val placementSpec = remember { tween<IntOffset>(220, easing = FastOutSlowInEasing) }
    val gridGesture = if (manualMode) Modifier.noteGridDragGestures(
        notes = notes,
        selectionMode = selectionMode,
        hitTest = { position ->
            val item = gridState.layoutInfo.visibleItemsInfo.firstOrNull { info ->
                info.key is String && (info.key as String).startsWith("note:") &&
                    position.x >= info.offset.x && position.x <= info.offset.x + info.size.width &&
                    position.y >= info.offset.y && position.y <= info.offset.y + info.size.height
            }
            val note = ordered.firstOrNull { item?.key == noteKey(it) }
            if (item != null && note != null) note to (position - Offset(item.offset.x.toFloat(), item.offset.y.toFloat()))
            else null
        },
        onClick = onCardClick,
        onLongPress = onCardLongClick,
        onDragStart = handleDragStart,
        onDragMove = handleDragMove,
        onDragEnd = handleDragEnd,
        onDragCancel = handleDragCancel,
    ) else Modifier

    Box(Modifier.fillMaxSize().then(gridGesture)) {
    LazyVerticalStaggeredGrid(
        columns = StaggeredGridCells.Fixed(columnCount),
        contentPadding = PaddingValues(horizontal = 10.dp, vertical = 8.dp),
        verticalItemSpacing = 10.dp,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
        state = gridState,
        modifier = Modifier.fillMaxSize(),
    ) {
        val pinned = ordered.filter { it.meta.pinned }
        val rest = ordered.filter { !it.meta.pinned }
        if (pinned.isNotEmpty()) {
            item(span = StaggeredGridItemSpan.FullLine, key = "label-pinned") {
                SectionLabel(stringResource(R.string.section_pinned))
            }
            items(pinned, key = { noteKey(it) }, contentType = { noteContentType(it) }) { note ->
                NoteCard(
                    note = note,
                    darkTheme = dark,
                    selectionMode = selectionMode,
                    isSelected = note.uri in selectedUris,
                    isDragPlaceholder = note.uri == draggingUri,
                    isDropTarget = note.uri == dropTarget,
                    modifier = if (manualMode) Modifier.animateItemPlacement(
                        animationSpec = placementSpec,
                    ) else Modifier,
                    manualMode = manualMode,
                    onClick = { onCardClick(note) },
                    onLongClick = { onCardLongClick(note) },
                    onPinClick = { onTogglePin(note) },
                    onChecklistClick = { index -> onToggleChecklist(note, index) },
                    onUrlClick = onUrlClick,
                )
            }
            item(span = StaggeredGridItemSpan.FullLine, key = "label-other") {
                SectionLabel(stringResource(R.string.section_other))
            }
        }
        items(rest, key = { noteKey(it) }, contentType = { noteContentType(it) }) { note ->
            NoteCard(
                note = note,
                darkTheme = dark,
                selectionMode = selectionMode,
                isSelected = note.uri in selectedUris,
                isDragPlaceholder = note.uri == draggingUri,
                isDropTarget = note.uri == dropTarget,
                modifier = if (manualMode) Modifier.animateItemPlacement(
                    animationSpec = placementSpec,
                ) else Modifier,
                manualMode = manualMode,
                onClick = { onCardClick(note) },
                onLongClick = { onCardLongClick(note) },
                onPinClick = { onTogglePin(note) },
                onChecklistClick = { index -> onToggleChecklist(note, index) },
                onUrlClick = onUrlClick,
            )
        }
    }
    if (draggedNote != null && dragSize.width > 0 && dragSize.height > 0) {
        NoteCard(
            note = draggedNote,
            darkTheme = dark,
            selectionMode = false,
            isSelected = false,
            onClick = {},
            onLongClick = {},
            onPinClick = {},
            onChecklistClick = {},
            onUrlClick = {},
            isDragging = true,
            dragPreview = true,
            modifier = Modifier
                .offset {
                    IntOffset(
                        dragOrigin.x + dragOffset.x.roundToInt(),
                        dragOrigin.y + dragOffset.y.roundToInt(),
                    )
                }
                .width(with(density) { dragSize.width.toDp() })
                .height(with(density) { dragSize.height.toDp() })
                .zIndex(2f)
                .clearAndSetSemantics {},
        )
    }
    }
}

private fun noteKey(note: NoteSummary): String = "note:" + note.uri.toString()

/**
 * Bepaalt de levende volgorde tijdens een drag: zet de gesleepte notitie op de
 * plek waarvoor de zichtbare buurkaarten boven het sleeppunt liggen. Beperkt tot
 * de eigen sectie (gepind/overige) — een gepinde kaart kan niet de "overige"-
 * sectie in.
 */
private fun reorderForDrag(
    gridState: LazyStaggeredGridState,
    ordered: List<NoteSummary>,
    draggedUri: Uri,
    draggedContentX: Float,
    draggedContentY: Float,
): List<NoteSummary> {
    val from = ordered.indexOfFirst { it.uri == draggedUri }
    if (from < 0) return ordered
    val dragged = ordered[from]
    val pinned = dragged.meta.pinned
    val pinnedCount = ordered.count { it.meta.pinned }

    val sectionUris = ordered
        .filter { it.meta.pinned == pinned && it.uri != draggedUri }
        .map { it.uri.toString() }
    val visible = gridState.layoutInfo.visibleItemsInfo
    val source = visible.firstOrNull { it.key == noteKey(dragged) }
    if (source != null && draggedContentX >= source.offset.x &&
        draggedContentX <= source.offset.x + source.size.width &&
        draggedContentY >= source.offset.y &&
        draggedContentY <= source.offset.y + source.size.height
    ) return ordered
    val target = visible.mapNotNull { info ->
        val key = (info.key as? String)?.removePrefix("note:") ?: return@mapNotNull null
        val index = sectionUris.indexOf(key)
        if (index < 0) return@mapNotNull null
        val centerX = info.offset.x + info.size.width / 2f
        val centerY = info.offset.y + info.size.height / 2f
        val dx = ((draggedContentX - centerX) / (info.size.width / 2f)).let { it * it }
        val dy = ((draggedContentY - centerY) / (info.size.height / 2f)).let { it * it }
        Triple(index, info, dx + dy)
    }.minByOrNull { it.third } ?: return ordered
    val (index, info) = target
    val centerX = info.offset.x + info.size.width / 2f
    val centerY = info.offset.y + info.size.height / 2f
    val horizontal = (draggedContentX - centerX) / info.size.width
    val vertical = (draggedContentY - centerY) / info.size.height
    val insertOffset = index + if (kotlin.math.abs(horizontal) > kotlin.math.abs(vertical)) {
        if (horizontal > 0) 1 else 0
    } else {
        if (vertical > 0) 1 else 0
    }

    val result = ordered.toMutableList()
    result.removeAt(from)
    val sectionStart = if (pinned) 0 else pinnedCount
    result.add(sectionStart + insertOffset, dragged)
    return result
}

/**
 * De grid blijft bestaan wanneer een kaart tijdens autoscroll uit beeld valt.
 * Daarom bewaakt zij de gesture in plaats van een virtueel kaart-item.
 */
private fun Modifier.noteGridDragGestures(
    notes: List<NoteSummary>,
    selectionMode: Boolean,
    hitTest: (Offset) -> Pair<NoteSummary, Offset>?,
    onClick: (NoteSummary) -> Unit,
    onLongPress: (NoteSummary) -> Unit,
    onDragStart: (NoteSummary, Offset) -> Unit,
    onDragMove: (NoteSummary, Offset) -> Unit,
    onDragEnd: (NoteSummary) -> Unit,
    onDragCancel: () -> Unit,
): Modifier = this.pointerInput(notes, selectionMode) {
    val longPressTimeout = viewConfiguration.longPressTimeoutMillis
    val touchSlop = viewConfiguration.touchSlop
    awaitEachGesture {
        // Initial pass: de hele kaart pakt de lange druk op, ook boven een
        // checklist of thumbnail. Een korte tap blijft voor het kind bestemd.
        val down = awaitFirstDown(requireUnconsumed = false, pass = PointerEventPass.Initial)
        val (note, localOffset) = hitTest(down.position) ?: return@awaitEachGesture
        var releasedWithoutMove = false
        var childHandledTap = false
        var dragActive = false
        var dragFinished = false
        try {
            // Kleine vingerbewegingen blijven een druk; voorbij touch slop
            // neemt de grid het scrollen over en mag een latere up niet klikken.
            val timedOut = withTimeoutOrNull(longPressTimeout) {
                while (true) {
                    val event = awaitPointerEvent(PointerEventPass.Initial)
                    val change = event.changes.firstOrNull { it.id == down.id } ?: break
                    if ((change.position - down.position).getDistance() > touchSlop) break
                    if (change.changedToUpIgnoreConsumed()) {
                        releasedWithoutMove = true
                        val finalEvent = awaitPointerEvent(PointerEventPass.Final)
                        childHandledTap = finalEvent.changes
                            .firstOrNull { it.id == down.id }?.isConsumed == true
                        break
                    }
                }
            }
            if (timedOut != null) {
                // Geen long-press: alleen een tap (up zonder beweging) opent de kaart.
                if (releasedWithoutMove && !childHandledTap) onClick(note)
                return@awaitEachGesture
            }

            // Long-press geslaagd. Als ouder van de scrollbare grid lezen we
            // verdere beweging op Initial en consumeren die vóór de grid.
            onDragStart(note, localOffset)
            dragActive = true
            var moved = false
            var total = Offset.Zero
            while (true) {
                val change = awaitPointerEvent(PointerEventPass.Initial).changes
                    .firstOrNull { it.id == down.id }
                if (change == null || change.isConsumed) {
                    onDragCancel()
                    dragFinished = true
                    break
                }
                if (change.changedToUpIgnoreConsumed()) {
                    change.consume()
                    if (moved) onDragEnd(note)
                    else {
                        onDragCancel()
                        onLongPress(note)
                    }
                    dragFinished = true
                    break
                }
                val delta = change.positionChange()
                if (delta.x != 0f || delta.y != 0f) {
                    moved = true
                    total += delta
                    onDragMove(note, total)
                }
                change.consume()
            }
        } finally {
            if (dragActive && !dragFinished) onDragCancel()
        }
    }
}

private fun applyFilters(
    notes: List<NoteSummary>,
    query: String,
    selectedTags: Set<String>,
): List<NoteSummary> {
    val q = query.trim().lowercase()
    if (q.isEmpty() && selectedTags.isEmpty()) return notes
    return notes.filter { note ->
        val matchesQuery = q.isEmpty() ||
            note.title.lowercase().contains(q) ||
            note.snippet.lowercase().contains(q) ||
            note.meta.tags.any { it.lowercase().contains(q) }
        // OR-semantiek binnen tags: notitie matcht als 'ie minstens één van de gekozen tags heeft.
        // Sparse handmatige tags maken AND-mode (vrijwel) altijd leeg, daarom OR.
        val matchesTags = selectedTags.isEmpty() ||
            note.meta.tags.any { it in selectedTags }
        matchesQuery && matchesTags
    }
}

private const val TAG_CHIPS_TOP_N = 8

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun SearchAndFilterBar(
    query: String,
    onQueryChange: (String) -> Unit,
    visibleTags: List<String>,
    selectedTags: Set<String>,
    overflowCount: Int,
    onTagToggle: (String) -> Unit,
    onClearTags: () -> Unit,
    onShowAllTags: () -> Unit,
) {
    Column(modifier = Modifier.fillMaxWidth().padding(horizontal = 10.dp, vertical = 4.dp)) {
        OutlinedTextField(
            value = query,
            onValueChange = onQueryChange,
            placeholder = { Text(stringResource(R.string.search_hint)) },
            leadingIcon = {
                Icon(Icons.Filled.Search, contentDescription = null)
            },
            trailingIcon = {
                if (query.isNotEmpty()) {
                    IconButton(onClick = { onQueryChange("") }) {
                        Icon(
                            Icons.Filled.Close,
                            contentDescription = stringResource(R.string.action_clear_search),
                        )
                    }
                }
            },
            singleLine = true,
            shape = RoundedCornerShape(12.dp),
            modifier = Modifier.fillMaxWidth(),
        )
        if (visibleTags.isNotEmpty() || overflowCount > 0) {
            Spacer(Modifier.height(6.dp))
            LazyRow(
                horizontalArrangement = Arrangement.spacedBy(6.dp),
                contentPadding = PaddingValues(vertical = 2.dp),
                modifier = Modifier.fillMaxWidth(),
            ) {
                if (selectedTags.isNotEmpty()) {
                    item(key = "__clear__") {
                        FilterChip(
                            selected = false,
                            onClick = onClearTags,
                            label = { Text(stringResource(R.string.tag_filter_clear)) },
                            leadingIcon = {
                                Icon(
                                    Icons.Filled.Close,
                                    contentDescription = null,
                                    modifier = Modifier.size(FilterChipDefaults.IconSize),
                                )
                            },
                        )
                    }
                }
                items(visibleTags, key = { it }) { tag ->
                    val isSelected = tag in selectedTags
                    FilterChip(
                        selected = isSelected,
                        onClick = { onTagToggle(tag) },
                        // Expliciet ✓-icoon bij selectie — vorm-gebaseerde bevestiging
                        // naast de kleurwissel, conform de UI-regel om niet alleen op
                        // kleur te leunen.
                        leadingIcon = if (isSelected) {
                            {
                                Icon(
                                    Icons.Filled.Done,
                                    contentDescription = null,
                                    modifier = Modifier.size(FilterChipDefaults.IconSize),
                                )
                            }
                        } else null,
                        label = { Text("#$tag") },
                    )
                }
                if (overflowCount > 0) {
                    item(key = "__more__") {
                        FilterChip(
                            selected = false,
                            onClick = onShowAllTags,
                            label = {
                                Text(stringResource(R.string.tag_overflow_more, overflowCount))
                            },
                        )
                    }
                }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun TagPickerSheet(
    allTags: List<String>,
    selectedTags: Set<String>,
    onTagToggle: (String) -> Unit,
    onDismiss: () -> Unit,
) {
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    var query by remember { mutableStateOf("") }
    val filtered = remember(allTags, query) {
        val q = query.trim().lowercase()
        if (q.isEmpty()) allTags
        else allTags.filter { it.lowercase().contains(q) }
    }
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = sheetState,
    ) {
        Column(modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp)) {
            Text(
                text = stringResource(R.string.tag_sheet_title),
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.SemiBold,
                modifier = Modifier.padding(bottom = 12.dp),
            )
            OutlinedTextField(
                value = query,
                onValueChange = { query = it },
                placeholder = { Text(stringResource(R.string.tag_sheet_search)) },
                leadingIcon = { Icon(Icons.Filled.Search, contentDescription = null) },
                trailingIcon = {
                    if (query.isNotEmpty()) {
                        IconButton(onClick = { query = "" }) {
                            Icon(
                                Icons.Filled.Close,
                                contentDescription = stringResource(R.string.action_clear_search),
                            )
                        }
                    }
                },
                singleLine = true,
                shape = RoundedCornerShape(12.dp),
                modifier = Modifier.fillMaxWidth(),
            )
            Spacer(Modifier.height(8.dp))
            if (filtered.isEmpty()) {
                Box(
                    modifier = Modifier.fillMaxWidth().padding(vertical = 32.dp),
                    contentAlignment = Alignment.Center,
                ) {
                    Text(
                        text = stringResource(R.string.tag_sheet_empty),
                        style = MaterialTheme.typography.bodyMedium,
                    )
                }
            } else {
                LazyColumn(modifier = Modifier.fillMaxWidth()) {
                    items(filtered, key = { it }) { tag ->
                        val isSelected = tag in selectedTags
                        Row(
                            modifier = Modifier
                                .fillMaxWidth()
                                .clickable { onTagToggle(tag) }
                                .padding(vertical = 12.dp, horizontal = 4.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            // Vaste 24dp-cel zodat selected/non-selected rijen identiek
                            // inspringen — vorm-gebaseerd: ✓ óf niets.
                            Box(
                                modifier = Modifier.size(24.dp),
                                contentAlignment = Alignment.Center,
                            ) {
                                if (isSelected) {
                                    Icon(
                                        Icons.Filled.Done,
                                        contentDescription = null,
                                        tint = MaterialTheme.colorScheme.primary,
                                    )
                                }
                            }
                            Spacer(Modifier.size(12.dp))
                            Text(
                                text = "#$tag",
                                style = MaterialTheme.typography.bodyLarge.copy(
                                    fontWeight = if (isSelected) FontWeight.SemiBold else FontWeight.Normal,
                                ),
                            )
                        }
                    }
                }
            }
            Spacer(Modifier.height(8.dp))
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
private fun SelectionTopBar(
    selectedCount: Int,
    canSelectAll: Boolean,
    canBulkAct: Boolean,
    onExit: () -> Unit,
    onSelectAll: () -> Unit,
    onArchive: () -> Unit,
    onDelete: () -> Unit,
) {
    TopAppBar(
        navigationIcon = {
            IconButton(onClick = onExit) {
                Icon(
                    Icons.Filled.Close,
                    contentDescription = stringResource(R.string.action_exit_selection),
                )
            }
        },
        title = {
            Text(
                text = stringResource(R.string.selection_count, selectedCount),
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.SemiBold,
            )
        },
        actions = {
            if (canSelectAll) {
                IconButton(onClick = onSelectAll) {
                    Icon(
                        Icons.Filled.DoneAll,
                        contentDescription = stringResource(R.string.action_select_all),
                    )
                }
            }
            IconButton(onClick = onArchive, enabled = canBulkAct) {
                Icon(
                    Icons.Filled.Archive,
                    contentDescription = stringResource(R.string.action_archive),
                )
            }
            IconButton(onClick = onDelete, enabled = canBulkAct) {
                Icon(
                    Icons.Filled.Delete,
                    contentDescription = stringResource(R.string.action_delete),
                )
            }
        },
        colors = TopAppBarDefaults.topAppBarColors(
            containerColor = Color.Transparent,
            scrolledContainerColor = Color.Transparent,
        ),
    )
}

@Composable
private fun repeatIndicatorLabel(repeat: String?): String? {
    if (repeat.isNullOrBlank()) return null
    return when {
        repeat.equals("daily", true) -> stringResource(R.string.repeat_daily)
        repeat.equals("weekly", true) || repeat.startsWith("weekly:", true) -> stringResource(R.string.repeat_weekly)
        repeat.equals("monthly", true) -> stringResource(R.string.repeat_monthly)
        repeat.equals("yearly", true) -> stringResource(R.string.repeat_yearly)
        repeat.startsWith("every:", true) -> stringResource(R.string.repeat_every)
        repeat.startsWith("ordinal:", true) -> stringResource(R.string.repeat_ordinal)
        else -> stringResource(R.string.repeat_every)
    }
}

@OptIn(ExperimentalMaterial3Api::class, ExperimentalFoundationApi::class)
@Composable
private fun NoteCard(
    note: NoteSummary,
    darkTheme: Boolean,
    selectionMode: Boolean,
    isSelected: Boolean,
    onClick: () -> Unit,
    onLongClick: () -> Unit,
    onPinClick: () -> Unit,
    onChecklistClick: (Int) -> Unit,
    onUrlClick: (String) -> Unit,
    isDragging: Boolean = false,
    isDragPlaceholder: Boolean = false,
    isDropTarget: Boolean = false,
    dragPreview: Boolean = false,
    manualMode: Boolean = false,
    modifier: Modifier = Modifier,
) {
    val bg = noteBackground(note.meta.color, darkTheme)
    val fg = contentColorOn(note.meta.color, darkTheme)
    // Brush + BorderStroke memoizen — Brush.linearGradient maakt anders bij elke
    // recomposition een nieuw object aan en dat zorgt voor GC-druk tijdens scroll.
    // CardDefaults.cardColors/cardElevation zijn @Composable en kunnen niet in
    // remember-blokken; die laten we Compose zelf afhandelen.
    val brush = remember(bg, darkTheme) { noteCardBrush(bg, darkTheme) }
    val primaryColor = MaterialTheme.colorScheme.primary
    val border = remember(fg, isSelected, isDropTarget, primaryColor) {
        if (isSelected || isDropTarget) androidx.compose.foundation.BorderStroke(2.dp, primaryColor)
        else androidx.compose.foundation.BorderStroke(0.7.dp, fg.copy(alpha = 0.08f))
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

    // De grid bewaakt handmatige gestures, ook wanneer deze kaart uit beeld
    // scrollt. Buiten Manual behoudt combinedClickable de bestaande ripple.
    val gestureModifier = if (dragPreview) {
        Modifier.graphicsLayer { scaleX = 1.03f; scaleY = 1.03f }
    } else if (manualMode) {
        Modifier.graphicsLayer { alpha = if (isDragPlaceholder) 0.16f else 1f }
    } else {
        Modifier
            .graphicsLayer { }
            .combinedClickable(
                onClick = onClick,
                onLongClick = onLongClick,
            )
    }

    Card(
        // Geen onClick op de Card: in Manual handelt de grid de gesture af,
        // anders combinedClickable hieronder.
        colors = CardDefaults.cardColors(containerColor = Color.Transparent, contentColor = fg),
        elevation = CardDefaults.cardElevation(defaultElevation = if (isDragging) 10.dp else 0.dp),
        shape = CARD_SHAPE,
        border = border,
        // graphicsLayer promoot de kaart naar een eigen render-layer; tijdens
        // scroll wordt de rasterized output gehergebruikt i.p.v. de gradient +
        // text+border opnieuw te tekenen per frame. Voorkomt frame drops.
        modifier = modifier
            .then(gestureModifier)
            .zIndex(if (isDragging) 1f else 0f),
    ) {
        Box(modifier = Modifier.fillMaxSize().background(brush = brush)) {
            Column {
                if (thumbnailUri != null) {
                    // De thumbnail hoort bij de kaart: een tap opent eerst de editor.
                    // Daar kan de gebruiker vervolgens de afbeelding groot openen.
                    AsyncImage(
                        // Decode begrenzen tot ~kaartgrootte i.p.v. de volledige
                        // foto-resolutie, en geen crossfade: scheelt geheugen en
                        // frame-tijd bij het scrollen door veel kaarten.
                        model = ImageRequest.Builder(LocalContext.current)
                            .data(thumbnailUri)
                            // 480 dekt een 2-koloms cel (~180dp) ook op hoge density
                            // ruim; 720 decodeerde onnodig groot via de trage SAF-laag.
                            .size(480)
                            .crossfade(false)
                            .build(),
                        contentDescription = null,
                        contentScale = ContentScale.Crop,
                        alignment = Alignment.Center,
                        modifier = Modifier
                            .fillMaxWidth()
                            .aspectRatio(16f / 9f)
                            .clickable(onClick = onClick),
                    )
                } else if (note.audioBasename != null) {
                    VoiceMemoBanner(foreground = fg)
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
                                if (selectionMode) { onClick(); return@ClickableText }
                                val urlAnn = annotated
                                    .getStringAnnotations(tag = "URL", start = offset, end = offset)
                                    .firstOrNull()
                                if (urlAnn != null) {
                                    onUrlClick(urlAnn.item)
                                    return@ClickableText
                                }
                                // Het glyph zelf is visueel groter dan zijn ene tekst-offset.
                                // Maak daarom de hele checklistregel klikbaar; URL's op dezelfde
                                // regel houden hierboven voorrang.
                                val lineStart = annotated.text.lastIndexOf('\n', offset - 1) + 1
                                val nextNewline = annotated.text.indexOf('\n', offset)
                                val lineEnd = if (nextNewline < 0) annotated.length else nextNewline
                                val checklistAnn = annotated
                                    .getStringAnnotations(tag = "CHECKLIST", start = lineStart, end = lineEnd)
                                    .firstOrNull()
                                if (checklistAnn != null) {
                                    checklistAnn.item.toIntOrNull()?.let(onChecklistClick)
                                    return@ClickableText
                                }
                                onClick()
                            },
                        )
                    }
                    if (note.urls.isNotEmpty()) {
                        Spacer(Modifier.height(8.dp))
                        // In selection-mode: link-chips niet kunnen klikken, zodat de
                        // hele kaart selecteerbaar blijft. We renderen ze wel (visueel
                        // beeld klopt nog), maar maken ze inert.
                        LinkChips(
                            note.urls,
                            foreground = fg,
                            onChipClick = if (selectionMode) ({ onClick() }) else onUrlClick,
                        )
                    }
                    if (note.meta.tags.isNotEmpty()) {
                        Spacer(Modifier.height(8.dp))
                        TagChips(note.meta.tags, foreground = fg)
                    }
                    Spacer(Modifier.height(8.dp))
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(
                            text = timestampText,
                            style = labelStyle,
                            color = timestampColor,
                        )
                        val repeatText = repeatIndicatorLabel(note.meta.reminderRepeat)
                        if (repeatText != null) {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Icon(
                                    imageVector = Icons.Filled.Repeat,
                                    contentDescription = null,
                                    tint = timestampColor,
                                    modifier = Modifier.size(14.dp),
                                )
                                Spacer(Modifier.size(3.dp))
                                Text(
                                    text = repeatText,
                                    style = labelStyle,
                                    color = timestampColor,
                                )
                            }
                        }
                    }
                }
            }
            // Rechtsboven: in selection-mode altijd ✓-circle (gevuld als selected,
            // alleen-outline als niet). Anders: de bestaande pin-knop als 'ie pinned is.
            if (selectionMode) {
                Icon(
                    imageVector = if (isSelected) Icons.Filled.CheckCircle else Icons.Filled.RadioButtonUnchecked,
                    contentDescription = stringResource(R.string.action_select_note),
                    tint = if (isSelected) primaryColor else fg.copy(alpha = 0.55f),
                    modifier = Modifier
                        .align(Alignment.TopEnd)
                        .padding(8.dp)
                        .size(24.dp),
                )
            } else {
                IconButton(
                    onClick = onPinClick,
                    modifier = Modifier
                        .align(Alignment.TopEnd)
                        .padding(4.dp)
                        .size(28.dp),
                ) {
                    Icon(
                        imageVector = if (note.meta.pinned) Icons.Filled.PushPin else Icons.Outlined.PushPin,
                        contentDescription = stringResource(
                            if (note.meta.pinned) R.string.action_unpin else R.string.action_pin
                        ),
                        tint = fg,
                    )
                }
            }
        }
    }
}

/**
 * Visuele banner bovenaan een voicememo-kaart: equalizer-icoon op een subtiele
 * tint van de kaartkleur. Statisch (de kaart speelt niet af), maar in één
 * oogopslag herkenbaar als audio-notitie.
 */
@Composable
private fun VoiceMemoBanner(foreground: Color) {
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .aspectRatio(16f / 9f)
            .background(foreground.copy(alpha = 0.10f)),
        contentAlignment = Alignment.Center,
    ) {
        Icon(
            imageVector = Icons.Filled.GraphicEq,
            contentDescription = stringResource(R.string.voice_memo_card_label),
            tint = foreground.copy(alpha = 0.85f),
            modifier = Modifier.size(64.dp),
        )
    }
}

@OptIn(androidx.compose.foundation.layout.ExperimentalLayoutApi::class)
@Composable
private fun TagChips(tags: List<String>, foreground: Color) {
    androidx.compose.foundation.layout.FlowRow(
        horizontalArrangement = Arrangement.spacedBy(4.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        for (tag in tags) {
            TagChip(tag, foreground)
        }
    }
}

private const val LINK_CHIPS_VISIBLE = 3

@OptIn(androidx.compose.foundation.layout.ExperimentalLayoutApi::class)
@Composable
private fun LinkChips(urls: List<String>, foreground: Color, onChipClick: (String) -> Unit) {
    val visible = urls.take(LINK_CHIPS_VISIBLE)
    val overflow = urls.size - visible.size
    androidx.compose.foundation.layout.FlowRow(
        horizontalArrangement = Arrangement.spacedBy(4.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        for (url in visible) {
            LinkChip(url = url, foreground = foreground, onClick = { onChipClick(url) })
        }
        if (overflow > 0) {
            Surface(
                color = foreground.copy(alpha = 0.06f),
                contentColor = foreground,
                shape = RoundedCornerShape(10.dp),
            ) {
                Text(
                    text = stringResource(R.string.link_chip_more, overflow),
                    style = MaterialTheme.typography.labelSmall.copy(fontWeight = FontWeight.Medium),
                    modifier = Modifier.padding(horizontal = 7.dp, vertical = 2.dp),
                )
            }
        }
    }
}

@Composable
private fun LinkChip(url: String, foreground: Color, onClick: () -> Unit) {
    val host = remember(url) { hostnameOf(url) }
    Surface(
        color = foreground.copy(alpha = 0.14f),
        contentColor = foreground,
        shape = RoundedCornerShape(10.dp),
        modifier = Modifier.clickable(onClick = onClick),
    ) {
        Text(
            text = host,
            style = MaterialTheme.typography.labelSmall.copy(
                fontWeight = FontWeight.Medium,
                textDecoration = TextDecoration.Underline,
            ),
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.padding(horizontal = 7.dp, vertical = 2.dp),
        )
    }
}

private fun hostnameOf(url: String): String {
    return try {
        val uri = java.net.URI(url)
        (uri.host ?: url).removePrefix("www.")
    } catch (_: Throwable) {
        url
    }
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
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

@Composable
private fun CenteredText(text: String) {
    Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Text(
            text = text,
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onBackground,
            textAlign = TextAlign.Center,
        )
    }
}

@Composable
private fun LoadingSpinner() {
    // Vervangt de eerdere kleine "Loading…"-tekst. Visuele consistentie met de
    // splash-spinner: één en hetzelfde draaiend-ring-idiom door de hele app.
    Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        CircularProgressIndicator(
            modifier = Modifier.size(48.dp),
            strokeWidth = 4.dp,
        )
    }
}

@Composable
private fun EmptyState(text: String, actionLabel: String, onAction: () -> Unit) {
    Box(modifier = Modifier.fillMaxSize().padding(24.dp), contentAlignment = Alignment.Center) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Text(
                text = text,
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onBackground,
                textAlign = TextAlign.Center,
            )
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
    data class Match(
        val start: Int,
        val end: Int,
        val display: String,
        val href: String? = null,
        val checklistIndex: Int? = null,
    )

    // Normaliseer de ondersteunde lijstsubset. Checklists eerst, zodat ze geen
    // gewone bullets worden; behoud voorloopinspringing voor geneste items.
    val source = text
        .replace(Regex("(?m)^([ \\t]*)-[ \\t]+\\[ \\]([ \\t]|$)")) {
            "${it.groupValues[1]}☐${it.groupValues[2]}"
        }
        .replace(Regex("(?m)^([ \\t]*)-[ \\t]+\\[[xX]\\]([ \\t]|$)")) {
            "${it.groupValues[1]}☑${it.groupValues[2]}"
        }
        .replace(Regex("(?m)^([ \\t]*)[-*+][ \\t]+")) {
            "${it.groupValues[1]}• "
        }
        .replace(Regex("(?m)^([ \\t]*)(\\d{1,9})[.)][ \\t]+")) {
            "${it.groupValues[1]}${it.groupValues[2]}. "
        }

    val wikiRegex = Regex("\\[\\[([^\\]\\|\\n]+)(?:\\|([^\\]\\n]+))?\\]\\]")
    val mdRegex = Regex("\\[([^\\]\\n]+)\\]\\((https?://[^)\\s]+)\\)")
    val urlRegex = Regex("https?://\\S+")
    val checklistRegex = Regex("(?m)^[ \\t]*([☐☑])(?=[ \\t]|$)")

    val matches = mutableListOf<Match>()
    checklistRegex.findAll(source).forEachIndexed { index, match ->
        val glyph = match.groups[1] ?: return@forEachIndexed
        matches.add(Match(glyph.range.first, glyph.range.last + 1, glyph.value, checklistIndex = index))
    }
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
            if (m.checklistIndex != null) {
                pushStringAnnotation(tag = "CHECKLIST", annotation = m.checklistIndex.toString())
                withStyle(SpanStyle(color = accent, fontWeight = FontWeight.Bold)) {
                    append(m.display)
                }
                pop()
            } else if (m.href != null) {
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

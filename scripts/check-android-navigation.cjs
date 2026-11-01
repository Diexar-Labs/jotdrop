const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..', 'android', 'app', 'src', 'main');
const source = name => fs.readFileSync(path.join(root, 'kotlin', 'com', 'diexar', 'keepcapture', name + '.kt'), 'utf8');
const list = source('NotesListActivity');
const service = source('VoiceMemoRecordingService');
const storage = source('Storage');
const drawer = source('JotDropNavigation');

assert(!list.includes('recorder.discard()'), 'Backgrounding must not discard recordings');
assert(list.includes('VoiceMemoRecordingService.recording'), 'Activity recreation must reuse recording state');
assert(list.includes('VoiceMemoRecordingService.pending'), 'Pending audio must survive activity recreation');
assert(!list.includes('memo.file.delete()'), 'A failed vault save must keep the recording');
assert(service.indexOf('startForeground(') < service.indexOf('media.start()'), 'Promote service before starting the microphone');
assert(service.includes('File(noBackupFilesDir,'), 'Pending audio must be durable but excluded from system backups');
assert(service.includes('context.noBackupFilesDir.canonicalFile'), 'Recovery must use the same no-backup folder');
const memoSave = list.slice(list.indexOf('private fun saveMemo('), list.indexOf('private fun discardPendingMemo()'));
assert(!memoSave.includes('lifecycleScope'), 'Activity destruction must not cancel memo-save cleanup');
assert(memoSave.includes('VoiceMemoSave.save('), 'Memo saves must use the shared save owner');
assert(list.includes('VoiceMemoSave.saving'), 'Saving state must survive Activity recreation');
const memoDialog = list.slice(list.indexOf('pendingMemo?.let'), list.indexOf('if (labelManagerOpen)'));
assert(memoDialog.includes('onOpenSettings'), 'A failed vault save must allow settings without discarding audio');
assert(service.includes('.putString(PENDING_FILE'), 'Persist finalized recording recovery');
assert(service.includes('START_NOT_STICKY'), 'Do not restart a killed microphone without user input');
assert(!source('VoiceMemoRecorder').includes('CountDownLatch'), 'Never block the service main looper');
assert(storage.includes('strict = true'), 'Metadata management must reject unreadable folders');
assert(storage.indexOf('val verified = readNote') < storage.indexOf('if (!sourceDoc.delete())'), 'Verify a move before deleting its source');
assert(storage.includes('"/Trash"'), 'Attachment refcounts must include Trash');
assert(storage.includes('FrontmatterWriter.applyLabels(current, labels)'), 'Label edits preserve the latest body and leave tags untouched');
const drawerBinding = list.slice(list.indexOf('JotDropDrawer('), list.indexOf('onManageLabels ='));
assert(!drawerBinding.includes('allTagsAlpha'), 'The drawer must not contain the tag list');
const labelDiscovery = storage.slice(storage.indexOf('private fun listLabels('), storage.indexOf('private fun saveLabels('));
assert(!labelDiscovery.includes('.meta.tags'), 'Do not discover collections from tags');
assert(labelDiscovery.includes('.meta.labels'), 'Only dedicated collection memberships belong in the drawer');
assert(!source('EditorActivity').includes('suggestions = Storage.getLabels(context)'), 'Labels must not become tag suggestions');
assert(drawer.includes('LabelManagerSheet') && drawer.includes('LabelAssignmentSheet'), 'Label creation and assignment must both be reachable');
const assignment = drawer.slice(drawer.indexOf('internal fun LabelAssignmentSheet'));
assert(assignment.includes('TriStateCheckbox'), 'Labels need checked and mixed membership, not a blind add button');
assert(assignment.includes('OutlinedTextField'), 'The assignment picker must support label search');
assert(assignment.includes('Storage.addLabel'), 'Create labels inline without leaving the note');
assert(source('EditorActivity').includes('LabelAssignmentSheet('), 'Individual notes need a direct labels picker');
const editor = source('EditorActivity');
const editorBody = editor.slice(editor.indexOf('private fun EditorBody('), editor.indexOf('private fun EditorNavHeader('));
for (const name of ['google', 'github']) assert(list.includes(`ProviderButton("${name}", stringResource(R.string.welcome_${name})`), `The welcome screen must offer ${name}`);
// Back arrow + 6 buttons of 48dp fit on a 360dp phone; a seventh slides over the back arrow.
const editorActions = editor.slice(editor.indexOf('actions = {', editor.indexOf('geen titel')), editor.indexOf('R.string.action_save)', editor.indexOf('geen titel')));
assert((editorActions.match(/IconButton\(/g) || []).length <= 6, 'The editor bar must not hold more than 6 buttons, or they cover the back arrow');
for (const name of ['action_color', 'action_link']) assert.match(editorActions, new RegExp(`DropdownMenuItem\\([^]*?R\\.string\\.${name}`), `${name} must stay reachable in the More menu`);
assert(editor.includes('mutableStateOf(initialUri == null)'), 'New notes must remain directly editable');
assert.match(editor, /bodyText = TextFieldValue\(loadedBody\)\s+bodyEditing = false/, 'Navigation must reset the link reading view');
assert(editorBody.includes('renderPreviewAnnotated(value.text, foreground, underlineLinks = false)'), 'Reuse the renderer with calm editor styling without changing the source body');
assert(list.includes('underlineLinks: Boolean = true'), 'Keep the existing list-card link styling by default');
assert.equal((list.match(/if \(underlineLinks\) TextDecoration.Underline else TextDecoration.None/g) || []).length, 2, 'Web and wiki link styles must both respect the reading style');
assert(editorBody.includes('val previewLinks = preview.getStringAnnotations("URL", 0, preview.length)'), 'Detect link bodies using actual renderer annotations');
assert(editorBody.includes('!bodyEditing && previewLinks.isNotEmpty()'), 'Only link bodies should enter reading view');
assert(editorBody.includes('TextButton(onClick = onEditBody)'), 'Reading view must have an accessible edit action');
assert(editorBody.includes('CustomAccessibilityAction('), 'Screen readers must be able to open individual preview links');
assert(editorBody.includes('Intent(Intent.ACTION_VIEW, Uri.parse(url))'), 'Link labels must open their annotated destination');
assert.match(editorBody, /TextField\(\s+value = value,\s+onValueChange = onValueChange/, 'Editing must retain the original Markdown value');
assert.equal((editor.match(/bodyText = bodyText.text,/g) || []).length, 3, 'All save paths must persist raw Markdown, never the preview');
for (const name of ['insertOcrAndEmbed', 'toggleOrInsertChecklist', 'insertText']) {
  const start = editor.indexOf(`fun ${name}(`);
  const end = editor.indexOf('\n    fun ', start + 1);
  assert(editor.slice(start, end < 0 ? undefined : end).includes('bodyEditing = true'), `${name} must reveal edits in the raw editor`);
}
assert.match(editor, /bodyText = TextFieldValue\(\s+text = newText,[\s\S]*?bodyEditing = true/, 'Inserted wiki links must enter editing mode');
assert(storage.includes('LabelNames.applyChanges(meta.labels, added, removed)'), 'Only user-toggled memberships may change');
assert(drawer.includes('Storage.addLabel(context, normalized)'), 'Creation must merge a fresh label registry under the write mutex');
assert(storage.includes('private fun saveLabels('), 'Callers must not overwrite label snapshots without coordination');
assert.match(storage, /suspend fun addLabel\([^\n]+noteWriteMutex\.withLock/);
assert.match(storage, /suspend fun refreshLabels\([^\n]+noteWriteMutex\.withLock/);
assert(storage.includes('saveLabels(context, getLabels(context) + label)'), 'Creation must read the registry inside the locked operation');
assert(list.includes('Storage.refreshLabels('), 'Discovery must use the coordinated registry operation');
const restoreAction = list.slice(list.indexOf('val toRestore ='), list.indexOf('onDelete = { showBulkDeleteDialog'));
assert(restoreAction.includes('ReminderScheduler.rescheduleAll(context)'), 'Restore must schedule Notes even while Archive or Trash is displayed');
assert(list.includes('LabelNames.matchesSelection(note.meta.allTags, selectedTags)'), 'Tag filtering must match label case-folding');
// First run: only people who came through the welcome screen get the short tour, never someone updating.
const tutorial = source(path.join('ui', 'FirstRunTutorial'));
const vaultPicked = list.slice(list.indexOf('private val pickVaultLauncher'), list.indexOf('private fun startWelcome('));
assert(vaultPicked.includes('Storage.setTutorialPending(this, true)'), 'Choosing a folder on the welcome screen must start the tour');
assert.equal((list.match(/setTutorialPending\([^)]*true\)/g) || []).length, 1, 'The welcome screen must be the only way into the tour, or people updating would get it');
for (const name of ['NEW_NOTE', 'VOICE_MEMO', 'PHOTO', 'PIN']) assert(list.includes(`TutorialTarget.${name}`), `A balloon must point at ${name}`);
assert(list.includes('FirstRunTutorial('), 'The notes screen must show the tour');
assert(list.includes('gesturesEnabled = !selectionMode && !isRecording && !tutorialActive'), 'The drawer must not slide open during the tour');
assert(tutorial.includes('R.string.tutorial_skip'), 'Skipping must be possible');
assert(tutorial.includes('BackHandler'), 'Back must end the tour');
assert(tutorial.includes('tutorial_sample'), 'Without cards the pin balloon points at an example card');
for (const folder of ['values', 'values-nl']) {
  const strings = fs.readFileSync(path.join(root, 'res', folder, 'strings.xml'), 'utf8');
  const lines = strings.split('\n').filter(line => line.includes('name="tutorial_'));
  assert.equal(lines.length, 9, `${folder} must hold all tour texts`);
  assert(!lines.some(line => line.includes('—')), `${folder}: no em-dashes in the tour`);
}
// Just signed in: straight to the notes, wherever the sign-in started; someone already signed in stays on the screen.
const cloudActivity = source('CloudActivity');
assert(cloudActivity.includes('var justSignedIn by rememberSaveable { mutableStateOf(welcome) }'), 'The welcome route counts as signing in, and rotating must not forget it');
assert.match(cloudActivity, /if \(wasConnected == false && connected\) justSignedIn = true/, 'Only a change from signed out to signed in may return to the notes');
const signedInReturn = cloudActivity.slice(cloudActivity.indexOf('if (justSignedIn) LaunchedEffect'), cloudActivity.indexOf('// From a conflict copy'));
for (const name of ['status?.enabled == true', 'CloudAccountFlow.recoveryCode == null', 'CloudAccountFlow.secureOffer == null', '!CloudAccountFlow.totpTurnedOn', 'onSignedIn()']) assert(signedInReturn.includes(name), `Return to the notes needs ${name}: the recovery code must not fall away`);
assert(!/if \(welcome\) LaunchedEffect/.test(cloudActivity), 'The return must not depend on the welcome route alone');
// The number of notes next to the name, handwritten and a little askew, like the board in Joplin (Eric, 1 Nov).
const titleBar = list.slice(list.indexOf('TopAppBar(', list.indexOf('SelectionTopBar(')), list.indexOf('actions = {', list.indexOf('TopAppBar(', list.indexOf('SelectionTopBar('))));
assert(titleBar.includes('R.plurals.notes_count'), 'The top bar must show the number of notes');
assert(titleBar.includes('fontFamily = Handwriting'), 'The number must be in the handwriting of the Joplin board');
assert(titleBar.includes('rotationZ = -2f'), 'The number must sit a little askew, like in Joplin');
assert.match(titleBar, /Modifier\.weight\(1f, fill = false\)\.alignByBaseline\(\)\.graphicsLayer/, 'On a narrow phone the number gives way, never the name');
assert.equal((titleBar.match(/Modifier\.weight\(/g) || []).length, 1, 'Only the number may give way');
for (const folder of ['values', 'values-nl', 'values-de', 'values-es', 'values-fr', 'values-it']) {
  assert(fs.readFileSync(path.join(root, 'res', folder, 'strings.xml'), 'utf8').includes('<plurals name="notes_count">'), `${folder} must say how many notes there are`);
}
const manifest = fs.readFileSync(path.join(root, 'AndroidManifest.xml'), 'utf8');
// Holding the app icon starts a voice memo. A launcher shortcut closes every open screen of its task,
// and the editor saves only on the way back: the shortcut needs its own task, or unsaved text is lost.
const launcherActivity = manifest.slice(manifest.indexOf('android:name=".NotesListActivity"'), manifest.indexOf('android:name=".EditorActivity"'));
assert(launcherActivity.includes('android:resource="@xml/shortcuts"'), 'The launcher activity must publish the voice memo shortcut');
const shortcutEntry = manifest.slice(manifest.indexOf('android:name=".VoiceMemoShortcutActivity"'), manifest.indexOf('android:name=".ShareActivity"'));
assert(shortcutEntry.includes('android:exported="false"'), 'Other apps must not be able to start the microphone');
assert(shortcutEntry.includes('android:taskAffinity=""'), 'The shortcut must not share a task with the editor');
assert(shortcutEntry.includes('android:excludeFromRecents="true"'), 'The shortcut screen must not show in recents');
assert(!shortcutEntry.includes('singleInstance'), 'The microphone permission result needs a normal launch mode');
const shortcuts = fs.readFileSync(path.join(root, 'res', 'xml', 'shortcuts.xml'), 'utf8');
assert(shortcuts.includes('android:targetClass="com.diexar.keepcapture.VoiceMemoShortcutActivity"'), 'The shortcut must open the voice memo screen');
assert(shortcuts.includes('android:shortcutShortLabel="@string/shortcut_voice_memo"'), 'The shortcut label must be translatable');
const shortcutActivity = source('VoiceMemoShortcutActivity');
for (const name of ['Storage.getVaultUri(this)', 'VoiceMemoRecordingService.recording.value', 'VoiceMemoRecordingService.pending.value', 'VoiceMemoRecordingService.restorePending(this)']) assert(shortcutActivity.includes(name), `Check ${name} before recording: no folder, a running recording or an unsaved memo must only open the app`);
assert(shortcutActivity.includes('Manifest.permission.RECORD_AUDIO'), 'A first use must ask for the microphone');
assert(shortcutActivity.includes('Intent.FLAG_ACTIVITY_REORDER_TO_FRONT'), 'Show the board without closing an open editor');
assert(!shortcutActivity.includes('CLEAR_TASK'), 'Never close the screens of the app');
assert(list.includes('!selectionMode && !isRecording && pendingMemo == null && !drawerState.isOpen'), 'The tour must not cover the stop button or the save dialog');
for (const [folder, hint] of [['values', 'Voice memo'], ['values-nl', 'Spraakmemo']]) {
  const strings = fs.readFileSync(path.join(root, 'res', folder, 'strings.xml'), 'utf8');
  assert(strings.includes(`<string name="shortcut_voice_memo">${hint}</string>`), `${folder}: the shortcut needs its label`);
  const balloon = strings.split('\n').find(line => line.includes('name="tutorial_voice_memo"'));
  assert(balloon.includes(hint), `${folder}: the microphone balloon must explain the shortcut, with the label people see`);
}
// The home screen widget: three buttons, no note text, so nothing private shows on the home screen.
const widgetEntry = manifest.slice(manifest.indexOf('android:name=".QuickCaptureWidget"'));
assert(manifest.includes('android:name=".QuickCaptureWidget"'), 'The widget must be registered');
assert(widgetEntry.slice(0, widgetEntry.indexOf('</receiver>')).includes('android:exported="false"'), 'Other apps must not be able to poke the widget');
assert(widgetEntry.slice(0, widgetEntry.indexOf('</receiver>')).includes('android.appwidget.action.APPWIDGET_UPDATE'), 'The launcher must be able to update the widget');
assert(widgetEntry.slice(0, widgetEntry.indexOf('</receiver>')).includes('@xml/quick_capture_widget_info'), 'The widget needs its description file');
const widget = source('QuickCaptureWidget');
assert(widget.includes('FLAG_IMMUTABLE'), 'Widget buttons need immutable pending intents');
assert(widget.includes('VoiceMemoShortcutActivity::class.java'), 'The voice button must reuse the shortcut, with its permission and recording checks');
assert(!/Storage\.|readText|openInputStream/.test(widget), 'The widget must not read notes');
assert(list.includes('override fun onNewIntent'), 'A widget tap must reach a list that is already open');
for (const name of ['QuickCaptureWidget.ACTION_NOTE', 'QuickCaptureWidget.ACTION_PHOTO']) assert(list.includes(name), `The list must handle ${name}`);
const widgetAction = list.slice(list.indexOf('private fun handleWidgetAction('));
assert(widgetAction.slice(0, widgetAction.indexOf('\n    }\n')).includes('Storage.getVaultUri(this) == null'), 'Without a folder the widget must leave the welcome screen in charge');
const widgetLayout = fs.readFileSync(path.join(root, 'res', 'layout', 'widget_quick_capture.xml'), 'utf8');
for (const id of ['widget_note', 'widget_voice', 'widget_photo']) assert(widgetLayout.includes(`@+id/${id}`), `The widget needs the ${id} button`);
for (const label of ['@string/widget_note', '@string/widget_voice', '@string/widget_photo']) assert(widgetLayout.includes(label), 'Every widget button needs a text label, not only an icon');
for (const folder of ['values', 'values-nl', 'values-de', 'values-es', 'values-fr', 'values-it']) {
  const strings = fs.readFileSync(path.join(root, 'res', folder, 'strings.xml'), 'utf8');
  for (const name of ['widget_name', 'widget_description', 'widget_note', 'widget_voice', 'widget_photo']) assert(strings.includes(`name="${name}"`), `${folder}: ${name} is missing`);
}
// The note widget: every copy shows its own note, and ticking on the home screen changes that note.
assert(manifest.includes('android:name=".NoteWidget"'), 'The note widget must be registered');
const noteWidgetEntry = manifest.slice(manifest.indexOf('android:name=".NoteWidget"'));
assert(noteWidgetEntry.slice(0, noteWidgetEntry.indexOf('</receiver>')).includes('android:exported="false"'), 'Other apps must not be able to tick items');
assert(manifest.includes('android.appwidget.action.APPWIDGET_CONFIGURE'), 'Placing a note widget must ask which note');
const noteService = manifest.slice(manifest.indexOf('android:name=".NoteWidgetService"'));
assert(noteService.slice(0, noteService.indexOf('/>')).includes('android.permission.BIND_REMOTEVIEWS'), 'Only the system may read the widget rows');
const noteWidget = source('NoteWidget');
assert(noteWidget.includes('Storage.noteWriteMutex'), 'A tick must wait for other note writes');
assert(noteWidget.includes('Storage.toggleChecklistItem'), 'A tick must use the same write as the board');
assert(noteWidget.includes('EXTRA_ROW_TEXT'), 'A tick must check that the row is still the one the person saw');
assert(noteWidget.includes('goAsync()'), 'Reading a note must not block the main thread');
assert(noteWidget.includes('FLAG_MUTABLE'), 'Rows fill in their own item, which needs a mutable template');
assert(noteWidget.includes('getAppWidgetInfo'), 'The note picker must only serve this app\'s own widgets');
assert(list.includes('HomeWidgets.refresh'), 'Opening the app must repair widgets after a force stop');
assert(source('CloudSyncManager').includes('HomeWidgets.refresh'), 'A background sync must update the widgets');
const noteRow = fs.readFileSync(path.join(root, 'res', 'layout', 'widget_note_item.xml'), 'utf8');
assert(noteRow.includes('@+id/widget_note_item_box'), 'A ticked item must differ by shape, not only by colour');
for (const folder of ['values', 'values-nl', 'values-de', 'values-es', 'values-fr', 'values-it']) {
  const strings = fs.readFileSync(path.join(root, 'res', folder, 'strings.xml'), 'utf8');
  for (const name of ['widget_note_name', 'widget_note_description', 'widget_note_pick', 'widget_note_gone', 'widget_note_empty', 'widget_note_none']) assert(strings.includes(`name="${name}"`), `${folder}: ${name} is missing`);
}
// Plus: a weekly ZIP. A half-written file never gets the name of a finished one, and only our own files are cleared.
const backup = source('CloudBackup');
assert(backup.includes('.part') && backup.includes('renameTo'), 'A backup must only get its name when it is finished');
assert(backup.includes('it.name?.startsWith(PREFIX)'), 'Clearing old backups must never touch other files in that folder');
assert(backup.includes('insideNotes'), 'A backup folder inside the notes folder would copy itself');
assert(backup.includes('hasPlus'), 'Backups are part of Plus');
assert(source('CloudActivity').includes('BackupSection'), 'The backup needs its place in the cloud screen');
assert(manifest.includes('android:foregroundServiceType="microphone"'));
assert(manifest.includes('android.permission.FOREGROUND_SERVICE_MICROPHONE'));
assert(manifest.includes('android.permission.WAKE_LOCK'));
console.log('Android navigation and recording safety wiring checks passed');

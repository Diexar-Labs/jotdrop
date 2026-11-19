const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..', 'android', 'app', 'src', 'main', 'kotlin', 'com', 'diexar', 'keepcapture');
const activity = fs.readFileSync(path.join(root, 'NotesListActivity.kt'), 'utf8');
const storage = fs.readFileSync(path.join(root, 'Storage.kt'), 'utf8');
const reload = activity.slice(activity.indexOf('private fun reload('), activity.indexOf('private fun setSortMode('));
const publish = reload.indexOf('notesState.value = result.fold');
assert(publish >= 0 && publish < reload.indexOf('Storage.refreshLabels('), 'Show cards before label discovery');
assert(publish < reload.indexOf('ReminderScheduler.rescheduleAll('), 'Reminders must not delay first cards');
assert(activity.includes('ReportDrawnWhen'), 'Use native fully-drawn reporting, not shell overhead');
assert(reload.includes('loadJob?.cancel()'), 'Do not stack outdated reload jobs');
const traversal = storage.slice(storage.indexOf('private fun traverseSubfolder('), storage.indexOf('private fun uniqueFilename('));
assert(!traversal.includes('.findFile('), 'Folder traversal must not query every child name individually');
assert(traversal.includes('contentResolver.query(') && traversal.includes('COLUMN_DISPLAY_NAME'), 'Use a bulk directory cursor');
// The label scan reads every note in Notes, Archive and Trash (10+ s on a real phone, 19 nov 2026).
// Under noteWriteMutex it held up trash, archive and the next card list for that long.
const refresh = storage.slice(storage.indexOf('suspend fun refreshLabels('), storage.indexOf('fun setExpires('));
const scanAt = refresh.indexOf('listLabels(');
assert(scanAt >= 0 && scanAt < refresh.indexOf('noteWriteMutex.withLock'), 'Scan labels before taking noteWriteMutex, only the save is locked');
const scan = storage.slice(storage.indexOf('private suspend fun listLabels('), storage.indexOf('private fun saveLabels('));
assert(scan.includes('ensureActive()'), 'A cancelled reload must stop its label scan, or scans pile up');
const rename = storage.slice(storage.indexOf('suspend fun renameLabel('), storage.indexOf('// ── Einde labels'));
assert(rename.includes('labelRemovals++'), 'Rename/delete must invalidate scans that started before it');
assert(refresh.includes('labelRemovals'), 'An older scan must not bring back a renamed or deleted label');
console.log('Android startup guards passed');

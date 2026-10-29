import { DatabaseSync } from 'node:sqlite';
import { open, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Also used to restore into a new location; never overwrites a running database. */
export async function backupCloudDatabase(source, destination) {
  if (!source || !destination || resolve(source) === resolve(destination)) throw new Error('Choose separate source and destination database files.');
  const database = new DatabaseSync(resolve(source), { readOnly: true, timeout: 5000 });
  let created = false;
  try {
    if (database.prepare('PRAGMA integrity_check').all()[0]?.integrity_check !== 'ok') throw new Error('Source database integrity check failed.');
    const file = await open(resolve(destination), 'wx', 0o600);
    created = true;
    await file.close();
    database.prepare('VACUUM INTO ?').run(resolve(destination));
    const restored = new DatabaseSync(resolve(destination), { readOnly: true });
    try {
      if (restored.prepare('PRAGMA integrity_check').all()[0]?.integrity_check !== 'ok') throw new Error('Backup integrity check failed.');
    } finally { restored.close(); }
  } catch (error) {
    if (created) await unlink(resolve(destination));
    throw error;
  } finally { database.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [source, destination] = process.argv.slice(2);
  try { await backupCloudDatabase(source, destination); console.log('Verified database copy created. Keep it on independent protected storage.'); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}

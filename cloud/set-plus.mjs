import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

/** Gives the cloud of an account email or vault ID JotDrop Plus until `plusUntil` (ms); 0 ends it. Until billing exists, this is how Plus is granted. */
export function setPlusUntil(dbPath, who, plusUntil) {
  if (!Number.isSafeInteger(plusUntil) || plusUntil < 0) throw new Error('Provide the end of Plus as a time in milliseconds, or 0.');
  const db = new DatabaseSync(dbPath, { timeout: 5000 });
  try {
    const vaultId = db.prepare('SELECT vaultId FROM accounts WHERE email=?').get(String(who).toLowerCase())?.vaultId ?? db.prepare('SELECT id FROM vaults WHERE id=?').get(who)?.id;
    if (!vaultId) throw new Error(`No cloud for ${who}.`);
    db.prepare('INSERT INTO plans(vaultId,plusUntil) VALUES(?,?) ON CONFLICT(vaultId) DO UPDATE SET plusUntil=excluded.plusUntil').run(vaultId, plusUntil);
    return vaultId;
  } finally { db.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [who, until] = process.argv.slice(2);
  if (!process.env.JOTDROP_CLOUD_DATA_DIR || !who || !/^(\d{4}-\d{2}-\d{2}|none)$/.test(until || '')) throw new Error('Usage: JOTDROP_CLOUD_DATA_DIR=<dir> node cloud/set-plus.mjs <email or vault ID> <YYYY-MM-DD | none>');
  const plusUntil = until === 'none' ? 0 : Date.parse(`${until}T23:59:59Z`);
  const vaultId = setPlusUntil(join(process.env.JOTDROP_CLOUD_DATA_DIR, 'cloud.db'), who, plusUntil);
  console.log(until === 'none' ? `Plus ended for cloud ${vaultId}.` : `Cloud ${vaultId} has Plus until ${new Date(plusUntil).toISOString()}.`);
}

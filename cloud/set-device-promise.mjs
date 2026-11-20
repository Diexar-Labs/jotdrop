import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

/**
 * Gives the cloud of an account email or vault ID the promise of the old trial mail ("They all keep working"): it syncs
 * `devices` devices without Plus, for good. 0 removes the promise. For someone who shows the old mail but was not recorded
 * when the server first started with sync on hold (Hand-off/ontwerp-sync-pauzeren-boven-free.md, deel 6).
 */
export function setDevicePromise(dbPath, who, devices, clock = Date.now) {
  if (!Number.isSafeInteger(devices) || devices < 0 || devices > 1000) throw new Error('Provide the number of devices, or 0.');
  const db = new DatabaseSync(dbPath, { timeout: 5000 });
  try {
    // The server records the promises once, when it creates this table; making the table here would skip that.
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='device_promises'").get()) throw new Error('This database has no device promises yet. Start the server with sync on hold once first.');
    const vaultId = db.prepare('SELECT vaultId FROM accounts WHERE email=?').get(String(who).toLowerCase())?.vaultId ?? db.prepare('SELECT id FROM vaults WHERE id=?').get(who)?.id;
    if (!vaultId) throw new Error(`No cloud for ${who}.`);
    if (devices === 0) db.prepare('DELETE FROM device_promises WHERE vaultId=?').run(vaultId);
    else db.prepare('INSERT INTO device_promises(vaultId,devices,grantedAt) VALUES(?,?,?) ON CONFLICT(vaultId) DO UPDATE SET devices=excluded.devices').run(vaultId, devices, clock());
    return vaultId;
  } finally { db.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [who, count] = process.argv.slice(2);
  if (!process.env.JOTDROP_CLOUD_DATA_DIR || !who || !/^(\d{1,4}|none)$/.test(count || '')) throw new Error('Usage: JOTDROP_CLOUD_DATA_DIR=<dir> node cloud/set-device-promise.mjs <email or vault ID> <number of devices | none>');
  const devices = count === 'none' ? 0 : Number(count);
  const vaultId = setDevicePromise(join(process.env.JOTDROP_CLOUD_DATA_DIR, 'cloud.db'), who, devices);
  console.log(devices ? `Cloud ${vaultId} syncs ${devices} devices without Plus.` : `The device promise of cloud ${vaultId} was removed.`);
}

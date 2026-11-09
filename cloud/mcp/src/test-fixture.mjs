// For the tests only: an in-process JotDrop Cloud (as cloud/server.test.mjs makes it), a "phone" that owns the
// vault and makes pairing codes, and a home folder for jotdrop-mcp. Everything is removed after the test.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCloudServer } from '../../server.mjs';
import { CloudClient } from '../../shared/client.mjs';
import { objectId, randomToken } from '../../shared/crypto.mjs';

const encoder = new TextEncoder(), decoder = new TextDecoder();

export async function cloudFixture(t, options = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'jotdrop-mcp-cloud-'));
  const homeDir = await mkdtemp(join(tmpdir(), 'jotdrop-mcp-home-'));
  const enrollmentToken = randomToken();
  const app = await createCloudServer({ freeDeviceLimit: 100, dataDir, enrollmentToken, ...options });
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); await rm(homeDir, { recursive: true, force: true }); });
  const url = `http://127.0.0.1:${app.port}`;
  const phone = (await CloudClient.create({ url, enrollmentToken, deviceName: 'Phone' })).client;
  const revisions = new Map();
  const id = (path) => objectId(phone.credentials.vaultKey, path);
  return {
    app, url, phone, home: join(homeDir, '.jotdrop-mcp'),
    pairingCode: async (deviceName = 'Claude op mijn pc') => (await phone.makePairing(deviceName)).pairingCode,
    /** The phone writes a note on top of the newest version. */
    async write(path, text) {
      const current = await phone.read(await id(path)).then((entry) => entry.revision, (error) => { if (error.status === 404) return 0; throw error; });
      const saved = await phone.write(path, encoder.encode(text), current);
      revisions.set(path, saved.revision);
      return saved;
    },
    async remove(path) {
      const entry = await phone.read(await id(path));
      return phone.remove(entry.id, entry.revision);
    },
    /** The note as the cloud has it now, as text; null when it is deleted or missing. */
    async read(path) {
      try {
        const entry = await phone.read(await id(path));
        return entry.deleted ? null : decoder.decode(entry.file.bytes);
      } catch (error) { if (error.status === 404) return null; throw error; }
    },
    /** Every live path in the vault. */
    async paths() {
      const found = [];
      for (let page = { cursor: 0, hasMore: true }; page.hasMore;) {
        page = await phone.listChanges(page.cursor);
        for (const change of page.changes) {
          const entry = await phone.read(change.id).catch(() => null);
          if (entry && !entry.deleted) found.push(entry.file.path);
        }
      }
      return [...new Set(found)].sort();
    },
  };
}

import { base64ToBytes, bytesToBase64, decodeRecovery, decryptEnvelope, encodeRecovery, encryptEnvelope, generateVaultKey, hashToken, MAX_FILE_BYTES, normalizePath, objectId, randomToken, validId } from './crypto.mjs';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

export class CloudError extends Error {
  constructor(message, status, currentRevision) { super(message); this.status = status; this.currentRevision = currentRevision; }
}

export function validateUrl(value) {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) || url.pathname !== '/') throw new Error('Use an HTTPS server URL, or HTTP on localhost for development.');
  return url.origin;
}

function name(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 80 || /[\x00-\x1f]/.test(value)) throw new Error('Enter a device name of 1 to 80 characters.');
  return value.trim();
}

function token(value) {
  if (base64ToBytes(value).length !== 32) throw new Error('Invalid device credentials.');
  return value;
}

async function request(url, path, { method = 'GET', body, headers = {}, fetcher = globalThis.fetch } = {}) {
  const response = await fetcher(`${validateUrl(url)}/api/v1${path}`, { method, headers: { ...headers, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(30000) });
  const reader = response.body?.getReader(), decoder = new TextDecoder(), chunks = [];
  let size = 0;
  try {
    if (Number(response.headers.get('content-length')) > MAX_RESPONSE_BYTES) throw new CloudError('The server response is too large.', 502);
    if (reader) while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new CloudError('The server response is too large.', 502);
      chunks.push(decoder.decode(value, { stream: true }));
    }
    chunks.push(decoder.decode());
  } finally {
    if (reader) { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  }
  let result;
  try { result = JSON.parse(chunks.join('')); } catch { throw new CloudError('The server did not return a valid response.', response.status); }
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new CloudError('The server did not return a valid response.', response.status);
  if (!response.ok) throw new CloudError(typeof result.error === 'string' ? result.error : 'Cloud request failed.', response.status, result.currentRevision);
  return result;
}

export class CloudClient {
  constructor({ url, vaultId, deviceId, token: deviceToken, vaultKey, fetcher = globalThis.fetch }) {
    if (!validId(vaultId) || !validId(deviceId)) throw new Error('Invalid workspace or device ID.');
    this.credentials = Object.freeze({ url: validateUrl(url), vaultId, deviceId, token: token(deviceToken), vaultKey: token(vaultKey) });
    this.fetcher = fetcher;
  }

  static async create({ url, enrollmentToken, deviceName, fetcher = globalThis.fetch }) {
    const deviceToken = randomToken(), recoveryToken = randomToken(), vaultKey = generateVaultKey();
    const created = await request(url, '/vaults', { method: 'POST', headers: { Authorization: `Bearer ${enrollmentToken}` }, body: { deviceName: name(deviceName), deviceTokenHash: await hashToken(deviceToken), recoveryTokenHash: await hashToken(recoveryToken) }, fetcher });
    const client = new CloudClient({ url, ...created, token: deviceToken, vaultKey, fetcher });
    return { client, recoveryCode: encodeRecovery({ vaultId: created.vaultId, vaultKey, recoveryToken }) };
  }

  static async recover({ url, recoveryCode, deviceName, fetcher = globalThis.fetch }) {
    const recovery = decodeRecovery(recoveryCode), deviceToken = randomToken();
    const recovered = await request(url, '/recover', { method: 'POST', body: { vaultId: recovery.vaultId, recoveryToken: recovery.recoveryToken, deviceName: name(deviceName), deviceTokenHash: await hashToken(deviceToken) }, fetcher });
    if (recovered.vaultId !== recovery.vaultId) throw new Error('Recovery returned the wrong workspace.');
    return new CloudClient({ url, ...recovered, token: deviceToken, vaultKey: recovery.vaultKey, fetcher });
  }

  call(path, method = 'GET', body) {
    const c = this.credentials;
    return request(c.url, path, { method, body, headers: { Authorization: `Bearer ${c.token}`, 'X-JotDrop-Vault': c.vaultId, 'X-JotDrop-Device': c.deviceId }, fetcher: this.fetcher });
  }

  async prepareWrite(path, bytes, baseRevision, modifiedAt = new Date().toISOString()) {
    normalizePath(path);
    if (!(bytes instanceof Uint8Array) || bytes.length > MAX_FILE_BYTES) throw new Error('Files in this preview must be 4 MiB or smaller.');
    if (!Number.isSafeInteger(baseRevision) || baseRevision < 0 || !Number.isFinite(Date.parse(modifiedAt))) throw new Error('Invalid file revision or date.');
    const id = await objectId(this.credentials.vaultKey, path);
    const envelope = await encryptEnvelope(this.credentials.vaultKey, { path, content: bytesToBase64(bytes), modifiedAt }, `jotdrop:object:v1:${this.credentials.vaultId}:${id}`);
    return { id, baseRevision, envelope: JSON.stringify(envelope) };
  }

  async commitWrite(prepared) {
    if (!/^[0-9a-f]{64}$/.test(prepared.id)) throw new Error('Invalid object ID.');
    const result = await this.call(`/objects/${prepared.id}`, 'PUT', { baseRevision: prepared.baseRevision, envelope: prepared.envelope });
    return { ...result, id: prepared.id };
  }

  async write(path, bytes, baseRevision, modifiedAt) { return this.commitWrite(await this.prepareWrite(path, bytes, baseRevision, modifiedAt)); }
  listChanges(after = 0) {
    if (!Number.isSafeInteger(after) || after < 0) throw new Error('Invalid changes cursor.');
    return this.call(`/changes?after=${after}`);
  }

  async read(id, revision) {
    if (!/^[0-9a-f]{64}$/.test(id) || (revision !== undefined && (!Number.isSafeInteger(revision) || revision < 1))) throw new Error('Invalid file revision.');
    const result = await this.call(`/objects/${id}${revision === undefined ? '' : `?revision=${revision}`}`);
    const file = await decryptEnvelope(this.credentials.vaultKey, JSON.parse(result.envelope), `jotdrop:object:v1:${this.credentials.vaultId}:${id}`);
    if (!file || normalizePath(file.path) !== file.path || typeof file.content !== 'string' || base64ToBytes(file.content).length > MAX_FILE_BYTES || !Number.isFinite(Date.parse(file.modifiedAt)) || await objectId(this.credentials.vaultKey, file.path) !== id) throw new Error('Encrypted file validation failed. No local files were changed.');
    return { ...result, file };
  }

  objectPath(id) { if (!/^[0-9a-f]{64}$/.test(id)) throw new Error('Invalid object ID.'); return `/objects/${id}`; }
  remove(id, baseRevision) { return this.call(this.objectPath(id), 'DELETE', { baseRevision }); }
  history(id) { return this.call(`${this.objectPath(id)}/history`); }
  restore(id, revision, baseRevision) { return this.call(`${this.objectPath(id)}/restore`, 'POST', { revision, baseRevision }); }
  status() { return this.call('/status'); }
  devices() { return this.call('/devices'); }
  revokeDevice(id) { if (!validId(id)) throw new Error('Invalid device ID.'); return this.call(`/devices/${id}`, 'DELETE'); }

  async makePairing(deviceName) {
    const deviceToken = randomToken(), wrappingKey = randomToken(), claimToken = randomToken();
    const { vaultId, vaultKey } = this.credentials;
    const envelope = await encryptEnvelope(wrappingKey, { vaultId, vaultKey, token: deviceToken }, 'jotdrop:pairing:v1');
    const paired = await this.call('/pairings', 'POST', { deviceName: name(deviceName), deviceTokenHash: await hashToken(deviceToken), claimTokenHash: await hashToken(claimToken), envelope: JSON.stringify(envelope) });
    return { pairingCode: bytesToBase64(encoder.encode(JSON.stringify({ v: 1, url: this.credentials.url, pairingId: paired.pairingId, claimToken, wrappingKey }))), expiresAt: paired.expiresAt };
  }

  static async claim({ pairingCode, fetcher = globalThis.fetch }) {
    if (typeof pairingCode !== 'string' || pairingCode.length > 4096) throw new Error('Invalid pairing code.');
    const pairing = JSON.parse(decoder.decode(base64ToBytes(pairingCode)));
    if (pairing.v !== 1 || !validId(pairing.pairingId)) throw new Error('Invalid pairing code.');
    token(pairing.claimToken); token(pairing.wrappingKey);
    const claimed = await request(pairing.url, `/pairings/${pairing.pairingId}/claim`, { method: 'POST', body: { claimToken: pairing.claimToken }, fetcher });
    const keys = await decryptEnvelope(pairing.wrappingKey, JSON.parse(claimed.envelope), 'jotdrop:pairing:v1');
    if (keys.vaultId !== claimed.vaultId) throw new Error('Pairing returned the wrong workspace.');
    return new CloudClient({ url: pairing.url, ...claimed, vaultKey: keys.vaultKey, token: keys.token, fetcher });
  }
}

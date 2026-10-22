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

export async function request(url, path, { method = 'GET', body, headers = {}, fetcher = globalThis.fetch, signal, binary = false } = {}) {
  const timeout = AbortSignal.timeout(30000);
  const response = await fetcher(`${validateUrl(url)}/api/v1${path}`, { method, headers: { ...headers, ...(body !== undefined ? { 'Content-Type': binary ? 'application/octet-stream' : 'application/json' } : {}) }, ...(body !== undefined ? { body: binary ? body : JSON.stringify(body) } : {}), cache: 'no-store', redirect: 'error', signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
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

async function uploadPath(prepared) {
  if (!/^[0-9a-f]{64}$/.test(prepared.id) || !Number.isSafeInteger(prepared.baseRevision) || prepared.baseRevision < 0 || prepared.baseRevision >= Number.MAX_SAFE_INTEGER || typeof prepared.envelope !== 'string' || prepared.envelope.length > 8 * 1024 * 1024) throw new Error('Invalid prepared upload.');
  const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(prepared.envelope)))].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `/objects/${prepared.id}/uploads/${prepared.baseRevision}/${digest}`;
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

  call(path, method = 'GET', body, { signal, binary = false } = {}) {
    const c = this.credentials;
    return request(c.url, path, { method, body, signal, binary, headers: { Authorization: `Bearer ${c.token}`, 'X-JotDrop-Vault': c.vaultId, 'X-JotDrop-Device': c.deviceId }, fetcher: this.fetcher });
  }

  async prepareWrite(path, bytes, baseRevision, modifiedAt = new Date().toISOString()) {
    normalizePath(path);
    if (!(bytes instanceof Uint8Array) || bytes.length > MAX_FILE_BYTES) throw new Error('Files in this preview must be 4 MiB or smaller.');
    if (!Number.isSafeInteger(baseRevision) || baseRevision < 0 || !Number.isFinite(Date.parse(modifiedAt))) throw new Error('Invalid file revision or date.');
    const id = await objectId(this.credentials.vaultKey, path);
    const envelope = await encryptEnvelope(this.credentials.vaultKey, { path, content: bytesToBase64(bytes), modifiedAt }, `jotdrop:object:v1:${this.credentials.vaultId}:${id}`);
    return { id, baseRevision, envelope: JSON.stringify(envelope) };
  }

  /** @param {{ resumable?: boolean, signal?: AbortSignal, onProgress?: (event: { phase: string, transferredBytes: number, totalBytes: number }) => void }} [options] */
  async commitWrite(prepared, options = {}) {
    let { resumable = false, signal, onProgress } = options;
    if (!/^[0-9a-f]{64}$/.test(prepared.id)) throw new Error('Invalid object ID.');
    if (!resumable) {
      const result = await this.call(`/objects/${prepared.id}`, 'PUT', { baseRevision: prepared.baseRevision, envelope: prepared.envelope }, { signal });
      return { ...result, id: prepared.id };
    }
    if (!Number.isSafeInteger(prepared.baseRevision) || prepared.baseRevision < 0 || prepared.baseRevision >= Number.MAX_SAFE_INTEGER || typeof prepared.envelope !== 'string' || prepared.envelope.length > 8 * 1024 * 1024) throw new Error('Invalid prepared upload.');
    const envelope = JSON.parse(prepared.envelope);
    if (envelope?.v !== 1 || JSON.stringify({ v: 1, iv: envelope.iv, ciphertext: envelope.ciphertext }) !== prepared.envelope) throw new Error('Resumable upload requires a canonical v1 envelope.');
    const iv = base64ToBytes(envelope.iv), ciphertext = base64ToBytes(envelope.ciphertext);
    if (iv.length !== 12 || ciphertext.length < 16 || iv.length + ciphertext.length > 6 * 1024 * 1024) throw new Error('Invalid binary envelope.');
    const bytes = new Uint8Array(iv.length + ciphertext.length);
    bytes.set(iv); bytes.set(ciphertext, iv.length);
    const path = await uploadPath(prepared);
    // Bound this attempt, not the durable upload: every HTTP request still has its own 30s limit.
    const budget = AbortSignal.timeout(10 * 60 * 1000);
    signal = signal ? AbortSignal.any([signal, budget]) : budget;
    const send = async (path, method, body, binary = false) => {
      signal.throwIfAborted();
      try { return await this.call(path, method, body, { signal, binary }); }
      catch (error) {
        if (signal.aborted || !(error instanceof TypeError || error.name === 'TimeoutError' || error.name === 'AbortError')) throw error;
        // One identical retry is safe for start, chunk and commit, including a lost successful response.
        return this.call(path, method, body, { signal, binary });
      }
    };
    const capability = (await send('/status')).transport;
    if (capability?.version !== 1 || capability.chunkBytes !== 65536) throw new Error('This server does not support resumable v1 uploads. The encrypted draft was kept.');
    let state = await send(path, 'POST', { size: bytes.length }), previous = 0;
    while (!state.committed) {
      if (state.size !== bytes.length || !Number.isSafeInteger(state.offset) || state.offset < previous || state.offset > bytes.length) throw new Error('Invalid upload acknowledgment. The encrypted draft was kept.');
      onProgress?.({ phase: state.offset === bytes.length ? 'committing' : 'upload', transferredBytes: state.offset, totalBytes: bytes.length });
      signal.throwIfAborted();
      if (state.offset === bytes.length) {
        state = await send(`${path}/commit`, 'POST', {});
        if (!state.committed) throw new Error('Missing upload commit acknowledgment. The encrypted draft was kept.');
      } else {
        const end = Math.min(state.offset + capability.chunkBytes, bytes.length);
        state = await send(`${path}?offset=${state.offset}`, 'PUT', bytes.subarray(state.offset, end), true);
        previous = end;
      }
    }
    const saved = state.committed;
    if (saved.id !== prepared.id || saved.revision !== prepared.baseRevision + 1 || !Number.isSafeInteger(saved.sequence) || saved.sequence < 1) throw new Error('Invalid upload commit acknowledgment. The encrypted draft was kept.');
    onProgress?.({ phase: 'committed', transferredBytes: bytes.length, totalBytes: bytes.length });
    return saved;
  }

  async discardWrite(prepared) {
    try { await this.call(await uploadPath(prepared), 'DELETE'); }
    catch (error) { if (![404, 410].includes(error.status)) throw error; }
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

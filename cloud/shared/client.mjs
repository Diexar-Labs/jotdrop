import { base64ToBytes, bytesToBase64, CHUNK_BYTES, decodeRecovery, decryptChunk, decryptEnvelope, encodeRecovery, encryptChunk, encryptEnvelope, generateVaultKey, hashToken, INLINE_BYTES, MAX_CHUNKED_BYTES, MAX_FILE_BYTES, normalizePath, objectId, randomToken, sha256Hex, validId } from './crypto.mjs';

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

/** `raw` returns a successful body as bytes (an encrypted piece) instead of JSON. */
export async function request(url, path, { method = 'GET', body, headers = {}, fetcher = globalThis.fetch, signal, binary = false, raw = false, limit = 30000 } = {}) {
  // A large note on a slow line can take minutes: the body only fails after 30s without any bytes, or at `limit`.
  const stalled = new AbortController();
  let idle;
  const wait = () => { clearTimeout(idle); idle = setTimeout(() => stalled.abort(new DOMException('The cloud stopped sending data.', 'TimeoutError')), 30000); };
  const timeout = AbortSignal.any([AbortSignal.timeout(limit), stalled.signal]);
  const response = await fetcher(`${validateUrl(url)}/api/v1${path}`, { method, headers: { ...headers, ...(body !== undefined ? { 'Content-Type': binary ? 'application/octet-stream' : 'application/json' } : {}) }, ...(body !== undefined ? { body: binary ? body : JSON.stringify(body) } : {}), cache: 'no-store', redirect: 'error', signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
  const reader = response.body?.getReader(), decoder = new TextDecoder(), chunks = [], parts = [];
  const bytes = raw && response.ok;
  let size = 0;
  try {
    if (Number(response.headers.get('content-length')) > MAX_RESPONSE_BYTES) throw new CloudError('The server response is too large.', 502);
    wait();
    if (reader) while (true) {
      const { done, value } = await reader.read();
      wait();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new CloudError('The server response is too large.', 502);
      if (bytes) parts.push(value); else chunks.push(decoder.decode(value, { stream: true }));
    }
    chunks.push(decoder.decode());
  } finally {
    clearTimeout(idle);
    if (reader) { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  }
  if (bytes) {
    const result = new Uint8Array(size);
    let offset = 0;
    for (const part of parts) { result.set(part, offset); offset += part.length; }
    return result;
  }
  let result;
  try { result = JSON.parse(chunks.join('')); } catch { throw new CloudError('The server did not return a valid response.', response.status); }
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new CloudError('The server did not return a valid response.', response.status);
  // `code` names a plan limit ('device-limit' lists the devices to choose from, 'plus-required').
  if (!response.ok) throw Object.assign(new CloudError(typeof result.error === 'string' ? result.error : 'Cloud request failed.', response.status, result.currentRevision), { code: result.code, devices: result.devices });
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

  static async recover({ url, recoveryCode, deviceName, replaceDeviceId, fetcher = globalThis.fetch }) {
    const recovery = decodeRecovery(recoveryCode), deviceToken = randomToken();
    const recovered = await request(url, '/recover', { method: 'POST', body: { vaultId: recovery.vaultId, recoveryToken: recovery.recoveryToken, deviceName: name(deviceName), deviceTokenHash: await hashToken(deviceToken), replaceDeviceId }, fetcher });
    if (recovered.vaultId !== recovery.vaultId) throw new Error('Recovery returned the wrong workspace.');
    return new CloudClient({ url, ...recovered, token: deviceToken, vaultKey: recovery.vaultKey, fetcher });
  }

  call(path, method = 'GET', body, { signal, binary = false, raw = false, limit } = {}) {
    const c = this.credentials;
    return request(c.url, path, { method, body, signal, binary, raw, limit, headers: { Authorization: `Bearer ${c.token}`, 'X-JotDrop-Vault': c.vaultId, 'X-JotDrop-Device': c.deviceId }, fetcher: this.fetcher });
  }

  /**
   * A v2 object: an encrypted manifest (path, size, fingerprint, pieces) plus encrypted pieces of 1 MiB.
   * Only the piece names are kept, so a prepared write stays small; `commitWrite` encrypts the pieces again from
   * the file, which gives the same bytes.
   */
  async prepareWrite(path, bytes, baseRevision, modifiedAt = new Date().toISOString()) {
    normalizePath(path);
    if (!(bytes instanceof Uint8Array) || bytes.length > MAX_CHUNKED_BYTES) throw new Error('Files can be at most 200 MB.');
    if (!Number.isSafeInteger(baseRevision) || baseRevision < 0 || !Number.isFinite(Date.parse(modifiedAt))) throw new Error('Invalid file revision or date.');
    const { vaultKey, vaultId } = this.credentials;
    const id = await objectId(vaultKey, path), chunks = [];
    if (bytes.length > INLINE_BYTES) {
      for (let index = 0; index * CHUNK_BYTES < bytes.length; index++) {
        const sealed = await encryptChunk(vaultKey, vaultId, id, index, bytes.subarray(index * CHUNK_BYTES, (index + 1) * CHUNK_BYTES));
        chunks.push({ name: await sha256Hex(sealed), size: sealed.length });
      }
    }
    const manifest = { v: 2, path, modifiedAt, size: bytes.length, hash: await sha256Hex(bytes), chunks, ...(chunks.length ? {} : { content: bytesToBase64(bytes) }) };
    const envelope = await encryptEnvelope(vaultKey, manifest, `jotdrop:object:v1:${vaultId}:${id}`);
    return { id, baseRevision, envelope: JSON.stringify(envelope), chunks: chunks.map((chunk) => chunk.name) };
  }

  /** One identical retry is safe for every transfer request, including a lost successful response. */
  async retrying(path, method, body, options) {
    options.signal?.throwIfAborted();
    try { return await this.call(path, method, body, options); }
    catch (error) {
      if (options.signal?.aborted || !(error instanceof TypeError || error.name === 'TimeoutError' || error.name === 'AbortError')) throw error;
      return this.call(path, method, body, options);
    }
  }

  /** Uploads the pieces the cloud does not have yet, then saves the manifest. `source` is the file the write was prepared from. */
  async commitPieces(prepared, { source, signal, onProgress } = {}) {
    const names = prepared.chunks;
    if (!/^[0-9a-f]{64}$/.test(prepared.id) || names.length > Math.ceil(MAX_CHUNKED_BYTES / CHUNK_BYTES) || names.some((name) => !/^[0-9a-f]{64}$/.test(name))) throw new Error('Invalid prepared upload.');
    // An older server would keep a manifest that older devices cannot read: never save there.
    const capability = (await this.retrying('/status', 'GET', undefined, { signal })).pieces;
    if (capability?.version !== 1 || capability.pieceBytes !== CHUNK_BYTES) throw new Error('This server does not support encrypted pieces. The encrypted draft was kept.');
    await this.uploadPieces(prepared, source, { signal, onProgress });
    const totalBytes = source?.length ?? 0;
    onProgress?.({ phase: 'committing', transferredBytes: totalBytes, totalBytes });
    // Not retried: a lost answer comes back as 409, and the caller compares with the cloud version as before.
    const saved = await this.call(`/objects/${prepared.id}`, 'PUT', { baseRevision: prepared.baseRevision, envelope: prepared.envelope, chunks: names }, { signal });
    onProgress?.({ phase: 'committed', transferredBytes: totalBytes, totalBytes });
    return { ...saved, id: prepared.id };
  }

  /** Sends the pieces of a prepared write that the cloud does not have yet, encrypted again from `source`. */
  async uploadPieces(prepared, source, { signal, onProgress } = {}) {
    const names = prepared.chunks, { vaultKey, vaultId } = this.credentials;
    const missing = new Set(names.length ? (await this.retrying('/chunks/missing', 'POST', { names }, { signal })).missing : []);
    if (missing.size && !(source instanceof Uint8Array)) throw new Error('The file is needed to finish this upload. The encrypted draft was kept.');
    const totalBytes = source?.length ?? 0;
    for (const [index, name] of names.entries()) {
      if (!missing.has(name)) continue;
      onProgress?.({ phase: 'upload', transferredBytes: Math.min(index * CHUNK_BYTES, totalBytes), totalBytes });
      const sealed = await encryptChunk(vaultKey, vaultId, prepared.id, index, source.subarray(index * CHUNK_BYTES, (index + 1) * CHUNK_BYTES));
      if (await sha256Hex(sealed) !== name) throw new Error('The file changed after it was prepared. The encrypted draft was kept.');
      // A piece of 1 MiB on a slow line: allow minutes, like a download.
      await this.retrying(`/chunks/${name}`, 'PUT', sealed, { signal, binary: true, limit: 5 * 60 * 1000 });
    }
  }

  /**
   * Moves versions saved before pieces (the whole file as base64 inside one envelope) into pieces, so they count
   * their real size. Per version: upload its pieces, read them back and compare, and only then ask the cloud to
   * swap. Revisions and history stay the same, so other devices download nothing; the cloud keeps the old envelope
   * aside for seven days.
   * @param {{ signal?: AbortSignal, onProgress?: (event: { done: number, total: number }) => void }} [options]
   */
  async convertLegacy({ signal, onProgress } = {}) {
    const total = (await this.retrying('/status', 'GET', undefined, { signal })).pieces?.legacy ?? 0;
    let converted = 0, kept = 0;
    for (let page = { cursor: '', hasMore: total > 0 }; page.hasMore;) {
      page = await this.retrying(`/pieces/legacy?after=${page.cursor}`, 'GET', undefined, { signal });
      for (const { id, envelopeHash, revision } of page.objects) {
        signal?.throwIfAborted();
        const { envelope, manifest } = await this.readManifest(id, revision);
        // Saved again or moved by another device meanwhile: a later run sees what is left.
        if (await sha256Hex(encoder.encode(envelope)) !== envelopeHash) continue;
        // Another device (or this page before a reload) may move the same version first: then there is nothing to do.
        const swap = (body) => this.retrying(`/objects/${id}/convert`, 'POST', body, { signal }).then(() => true, (error) => { if (error.status === 404 || error.status === 409) return false; throw error; });
        if (manifest.size <= INLINE_BYTES) {
          // Would stay inside a manifest, at the same size: only marked as checked.
          if (!await swap({ from: envelopeHash })) continue;
          kept++;
        } else {
          const prepared = await this.prepareWrite(manifest.path, manifest.bytes, 0, manifest.modifiedAt);
          await this.uploadPieces(prepared, manifest.bytes, { signal });
          const pieces = prepared.chunks.map((name, index) => ({ name, size: Math.min(CHUNK_BYTES, manifest.size - index * CHUNK_BYTES) + 28 }));
          await this.readPieces(id, { size: manifest.size, hash: manifest.hash, pieces });
          if (!await swap({ from: envelopeHash, envelope: prepared.envelope, chunks: prepared.chunks })) continue;
          // The version as other devices will now read it: the checked pieces and the same fingerprint.
          const swapped = (await this.readManifest(id, revision)).manifest;
          if (swapped.hash !== manifest.hash || swapped.pieces.map((piece) => piece.name).join() !== prepared.chunks.join()) throw new Error('A file moved into pieces did not read back the same. The cloud keeps the old copy for seven days.');
          converted++;
        }
        onProgress?.({ done: converted + kept, total });
      }
    }
    return { converted, kept };
  }

  /** @param {{ resumable?: boolean, source?: Uint8Array, signal?: AbortSignal, onProgress?: (event: { phase: string, transferredBytes: number, totalBytes: number }) => void }} [options] `source`: the file a v2 draft was prepared from, for the pieces the cloud does not have yet. */
  async commitWrite(prepared, options = {}) {
    if (Array.isArray(prepared.chunks)) return this.commitPieces(prepared, options);
    // A v1 draft prepared before this version: the single-envelope upload.
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

  async write(path, bytes, baseRevision, modifiedAt) { return this.commitWrite(await this.prepareWrite(path, bytes, baseRevision, modifiedAt), { source: bytes }); }
  listChanges(after = 0) {
    if (!Number.isSafeInteger(after) || after < 0) throw new Error('Invalid changes cursor.');
    return this.call(`/changes?after=${after}`);
  }

  /**
   * The manifest only: `{ path, modifiedAt, size, hash, pieces }`, plus `bytes` when the file is inside it (a v1
   * object or a small v2 file). Enough to compare with a local file without downloading its pieces.
   */
  async readManifest(id, revision) {
    if (!/^[0-9a-f]{64}$/.test(id) || (revision !== undefined && (!Number.isSafeInteger(revision) || revision < 1))) throw new Error('Invalid file revision.');
    // A v1 note of up to 4 MiB: allow minutes on a slow line.
    const result = await this.call(`/objects/${id}${revision === undefined ? '' : `?revision=${revision}`}`, 'GET', undefined, { limit: 5 * 60 * 1000 });
    const value = await decryptEnvelope(this.credentials.vaultKey, JSON.parse(result.envelope), `jotdrop:object:v1:${this.credentials.vaultId}:${id}`);
    const invalid = () => { throw new Error('Encrypted file validation failed. No local files were changed.'); };
    if (!value || typeof value.path !== 'string' || normalizePath(value.path) !== value.path || !Number.isFinite(Date.parse(value.modifiedAt)) || await objectId(this.credentials.vaultKey, value.path) !== id) invalid();
    let manifest;
    if (value.v === 2) {
      const pieces = value.chunks;
      if (!Number.isSafeInteger(value.size) || value.size < 0 || value.size > MAX_CHUNKED_BYTES || !/^[0-9a-f]{64}$/.test(value.hash) || !Array.isArray(pieces)) invalid();
      if (pieces.length !== (value.size > INLINE_BYTES ? Math.ceil(value.size / CHUNK_BYTES) : 0) || pieces.some((piece, index) => !/^[0-9a-f]{64}$/.test(piece?.name) || piece.size !== Math.min(CHUNK_BYTES, value.size - index * CHUNK_BYTES) + 28)) invalid();
      const bytes = pieces.length ? undefined : base64ToBytes(typeof value.content === 'string' ? value.content : invalid());
      if (bytes && (bytes.length !== value.size || await sha256Hex(bytes) !== value.hash)) invalid();
      manifest = { path: value.path, modifiedAt: value.modifiedAt, size: value.size, hash: value.hash, pieces, bytes };
    } else {
      const bytes = typeof value.content === 'string' ? base64ToBytes(value.content) : invalid();
      if (bytes.length > MAX_FILE_BYTES) invalid();
      manifest = { path: value.path, modifiedAt: value.modifiedAt, size: bytes.length, hash: await sha256Hex(bytes), pieces: [], bytes };
    }
    return { ...result, manifest };
  }

  /** The file's bytes from its manifest, piece by piece; each piece and the whole file are checked. */
  async readPieces(id, manifest) {
    if (manifest.bytes) return manifest.bytes;
    const { vaultKey, vaultId } = this.credentials, bytes = new Uint8Array(manifest.size);
    for (const [index, piece] of manifest.pieces.entries()) {
      const sealed = await this.call(`/chunks/${piece.name}`, 'GET', undefined, { raw: true, limit: 5 * 60 * 1000 });
      if (sealed.length !== piece.size || await sha256Hex(sealed) !== piece.name) throw new Error('An encrypted piece did not match. No local files were changed.');
      bytes.set(await decryptChunk(vaultKey, vaultId, id, index, sealed), index * CHUNK_BYTES);
    }
    if (await sha256Hex(bytes) !== manifest.hash) throw new Error('Encrypted file validation failed. No local files were changed.');
    return bytes;
  }

  /** The whole file: `file` is `{ path, content, modifiedAt }` with base64 content, and `file.bytes` the same bytes. */
  async read(id, revision) {
    const { manifest, ...result } = await this.readManifest(id, revision);
    const bytes = await this.readPieces(id, manifest);
    const file = { path: manifest.path, content: bytesToBase64(bytes), modifiedAt: manifest.modifiedAt, bytes };
    // Left out of JSON and copies: stored drafts and caches keep the base64 content only.
    Object.defineProperty(file, 'bytes', { enumerable: false });
    return { ...result, file };
  }

  objectPath(id) { if (!/^[0-9a-f]{64}$/.test(id)) throw new Error('Invalid object ID.'); return `/objects/${id}`; }
  remove(id, baseRevision) { return this.call(this.objectPath(id), 'DELETE', { baseRevision }); }
  history(id) { return this.call(`${this.objectPath(id)}/history`); }
  restore(id, revision, baseRevision) { return this.call(`${this.objectPath(id)}/restore`, 'POST', { revision, baseRevision }); }
  /** Every file as it was at `at`, page by page: `{ id, revision, deleted, size, updatedAt, locked, cleared }`. */
  async snapshot(at) {
    if (!Number.isFinite(Date.parse(at))) throw new Error('Invalid moment.');
    const objects = [];
    for (let page = { cursor: '', hasMore: true }; page.hasMore;) {
      page = await this.call(`/snapshot?at=${encodeURIComponent(new Date(at).toISOString())}&after=${page.cursor}`);
      objects.push(...page.objects);
    }
    return { objects };
  }
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

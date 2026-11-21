// Types for client.mjs, for the TypeScript of the Obsidian plugin. The code is client.mjs; this file only states the types.
// Server answers are described as far as the plugin reads them; other fields may be present.

export type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;
export type Credentials = Readonly<{ url: string; vaultId: string; deviceId: string; token: string; vaultKey: string }>;
export type CallOptions = { signal?: AbortSignal; binary?: boolean; raw?: boolean; limit?: number };
/** A JSON answer from the cloud. */
export type CloudAnswer = Record<string, unknown>;

export class CloudError extends Error {
  constructor(message: string, status?: number, currentRevision?: number);
  status?: number;
  currentRevision?: number;
  /** A plan limit, such as 'device-limit', 'plus-required' or 'device-paused'. */
  code?: string;
  devices?: unknown;
}

export function validateUrl(value: string): string;
export function identifyClient(app?: string, version?: string): void;
export function request<T = CloudAnswer>(url: string, path: string, options?: CallOptions & { method?: string; body?: unknown; headers?: Record<string, string>; fetcher?: Fetcher }): Promise<T>;

/** An encrypted write that is ready to send; `chunks` lists the pieces of a v2 object. */
export type Prepared = { id: string; baseRevision: number; envelope: string; chunks?: string[] };
/** The cloud's version of a file after a write or delete. */
export type SavedObject = { id: string; revision: number; sequence?: number };
export type Piece = { name: string; size: number };
export type Manifest = { path: string; modifiedAt: string; size: number; hash: string; pieces: Piece[]; bytes?: Uint8Array };
export type StoredObject = { revision: number; deleted?: boolean; envelope: string; updatedAt?: string };
export type CloudFile = { path: string; content: string; modifiedAt: string; bytes: Uint8Array };
export type Change = { id: string; revision: number; deleted?: boolean; updatedAt: string };
export type ChangesPage = { changes: Change[]; cursor: number; hasMore: boolean };
export type SnapshotFile = { id: string; revision: number | null; deleted: boolean; size?: number; updatedAt?: string; locked: boolean; cleared: boolean };
export type Progress = { phase: string; transferredBytes: number; totalBytes: number };
export type CloudStatus = {
  usedBytes?: number;
  quotaBytes?: number;
  plan?: { name?: string; [key: string]: unknown };
  mail?: { domain: string | null; enabled: boolean; publicKey: string | null; address: string | null; mode: string | null; pending: number };
  pieces?: { version?: number; pieceBytes?: number; maxFileBytes?: number; legacy?: number };
  transport?: { version?: number; chunkBytes?: number };
  [key: string]: unknown;
};

/** A device that went on hold because this one signed in in its place (the server's `onHold`). */
export type OnHold = { id: string; name: string };
/** Keeps the server's `onHold` on the client, so the app can say which device went on hold. */
export function withOnHold<C extends CloudClient>(client: C, answer?: { onHold?: unknown } | null): C;

export class CloudClient {
  constructor(options: { url: string; vaultId: string; deviceId: string; token: string; vaultKey: string; fetcher?: Fetcher });
  readonly credentials: Credentials;
  fetcher: Fetcher;
  /** Set after signing in in place of a device when the server put another device on hold. */
  onHold?: OnHold;
  static create(options: { url: string; enrollmentToken: string; deviceName: string; fetcher?: Fetcher }): Promise<{ client: CloudClient; recoveryCode: string }>;
  static recover(options: { url: string; recoveryCode: string; deviceName: string; replaceDeviceId?: string; fetcher?: Fetcher }): Promise<CloudClient>;
  static claim(options: { pairingCode: string; fetcher?: Fetcher }): Promise<CloudClient>;
  /** `T` is the shape of the JSON answer of this path; `raw` gives the bytes instead. */
  call<T = CloudAnswer>(path: string, method?: string, body?: unknown, options?: CallOptions): Promise<T>;
  prepareWrite(path: string, bytes: Uint8Array, baseRevision: number, modifiedAt?: string): Promise<Prepared & { chunks: string[] }>;
  commitWrite(prepared: Prepared, options?: { resumable?: boolean; source?: Uint8Array; signal?: AbortSignal; onProgress?: (event: Progress) => void }): Promise<SavedObject>;
  discardWrite(prepared: Prepared): Promise<void>;
  convertLegacy(options?: { signal?: AbortSignal; onProgress?: (event: { done: number; total: number }) => void }): Promise<{ converted: number; kept: number }>;
  write(path: string, bytes: Uint8Array, baseRevision: number, modifiedAt?: string): Promise<SavedObject>;
  listChanges(after?: number): Promise<ChangesPage>;
  readManifest(id: string, revision?: number): Promise<StoredObject & { manifest: Manifest }>;
  readPieces(id: string, manifest: Pick<Manifest, "size" | "hash" | "pieces" | "bytes">): Promise<Uint8Array>;
  read(id: string, revision?: number): Promise<StoredObject & { file: CloudFile }>;
  objectPath(id: string): string;
  remove(id: string, baseRevision: number): Promise<SavedObject>;
  purge(path: string, baseRevision: number): Promise<SavedObject>;
  history(id: string): Promise<CloudAnswer>;
  restore(id: string, revision: number, baseRevision: number): Promise<SavedObject>;
  snapshot(at: string): Promise<{ objects: SnapshotFile[] }>;
  status(): Promise<CloudStatus>;
  devices(): Promise<CloudAnswer>;
  revokeDevice(id: string): Promise<CloudAnswer>;
  /** Which devices go on syncing while the cloud has more devices than its plan syncs; 409 'choice-wait' says from when it may change again. */
  setSyncDevices(deviceIds: string[]): Promise<CloudAnswer>;
  makePairing(deviceName: string): Promise<{ pairingCode: string; expiresAt: string }>;
}

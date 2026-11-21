// Types for crypto.mjs, for the TypeScript of the Obsidian plugin. The code is crypto.mjs; this file only states the types.

/** An encrypted value as JSON: AES-GCM with a 12-byte iv, both base64url. */
export type Envelope = { v: 1; iv: string; ciphertext: string };

export const MAX_FILE_BYTES: number;
export const CHUNK_BYTES: number;
export const INLINE_BYTES: number;
export const MAX_CHUNKED_BYTES: number;

export function bytesToBase64(bytes: Uint8Array): string;
export function base64ToBytes(value: string): Uint8Array;
export function randomToken(): string;
export function generateVaultKey(): string;
export function hashToken(token: string): Promise<string>;
export function isSpacePath(path: string): boolean;
export function normalizePath(path: string): string;
export function objectId(vaultKey: string, path: string): Promise<string>;
export function encryptEnvelope(vaultKey: string, payload: unknown, aad: string): Promise<Envelope>;
/** The decrypted JSON; `T` is what the caller stored under this `aad`. */
export function decryptEnvelope<T = unknown>(vaultKey: string, envelope: Envelope, aad: string): Promise<T>;
export function sha256Hex(bytes: Uint8Array): Promise<string>;
export function encryptChunk(vaultKey: string, vaultId: string, id: string, index: number, plain: Uint8Array): Promise<Uint8Array>;
export function decryptChunk(vaultKey: string, vaultId: string, id: string, index: number, sealed: Uint8Array): Promise<Uint8Array>;
export function sealLocal(value: unknown, password: string): Promise<unknown>;
export function unsealLocal<T = unknown>(sealed: unknown, password: string): Promise<T>;
export function validId(value: unknown): value is string;
export function encodeRecovery(recovery: { vaultId: string; vaultKey: string; recoveryToken: string }): string;
export function decodeRecovery(code: string): { vaultId: string; vaultKey: string; recoveryToken: string };

// Types for mail.mjs, for the TypeScript of the Obsidian plugin. The code is mail.mjs; this file only states the types.

/** An opened mail (format 1); the fields come from the sender, so `mailToNote` checks each one. */
export type MailPayload = { v: 1; subject?: unknown; from?: unknown; date?: unknown; text?: unknown; attachments?: unknown };
export type MailAttachment = { part: number; type: string; name: string };

export const MAX_MAIL_BYTES: number;
export const MAX_PENDING_ITEMS: number;
export const MAX_PENDING_BYTES: number;
export const MAILS_PER_HOUR: number;
export const MAILS_PER_DAY: number;
export const ADDRESS_ALPHABET: string;

export function mailAddress(domain: string | null): string;
export function addressHash(address: string): Promise<string>;
export function senderHash(sender: string): Promise<string>;
export function importMailPrivate(scalar: Uint8Array): Promise<CryptoKey>;
/** The account's mail key, derived from the vault key: `publicKey` is the X25519 key as base64url. */
export function mailKeyPair(vaultKey: string): Promise<{ privateKey: CryptoKey; publicKey: string }>;
export function mailAesKey(secret: Uint8Array, ephemeralPublic: Uint8Array, accountPublic: Uint8Array, mailId: string): Promise<CryptoKey>;
export function sealMail(accountPublic: string, vaultId: string, mailId: string, payload: unknown, parts?: Uint8Array[]): Promise<Record<string, unknown>>;
export function openMailKey(privateKey: CryptoKey, accountPublic: string, ephemeralKey: string, mailId: string): Promise<CryptoKey>;
export function openMailBody(key: CryptoKey, vaultId: string, mailId: string, sealed: string): Promise<MailPayload>;
export function openMailPart(key: CryptoKey, vaultId: string, mailId: string, n: number, sealed: string): Promise<Uint8Array>;
export function mailToNote(payload: MailPayload, mailId: string, receivedAt: string): { path: string; content: string; attachments: MailAttachment[] };

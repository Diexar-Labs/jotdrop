// The shared Ask JotDrop code (cloud/shared/ai and the web app's pure note functions), with the types the plugin
// uses. TypeScript reads the JavaScript itself and guesses too narrow types (optional fields as required, lists as
// never[]); this file only states them, the code is the shared code unchanged.
import { runAssistant as run } from "../cloud/shared/ai/assistant.mjs";
import { selectNotes as select } from "../cloud/shared/ai/context.mjs";
import { parseMarkdown as parse } from "../cloud/shared/ai/markdown.mjs";
import * as parts from "../cloud/shared/ai/parts.mjs";
import * as receipt from "../cloud/shared/ai/receipt.mjs";
import { diffLines as diff, foldUnchanged as fold } from "../cloud/shared/diff.mjs";
import { digestRequest as digestAsk, weekDigest as digest } from "../cloud/shared/ai/digest.mjs";
import { findDuplicates as similar, pairKey as pairs } from "../cloud/shared/similar.mjs";
import * as keysync from "../cloud/shared/ai/keysync.mjs";
import * as web from "../cloud/web/ai-web.mjs";
import { joinNote as join, splitNote as split } from "../cloud/web/note.mjs";
export { AiError, PROVIDERS, TRANSCRIBE_MODEL, createProvider, pickDefaultModel } from "../cloud/shared/ai/providers.mjs";
export { FILE_TIMEOUT_MS } from "../cloud/shared/ai/assistant.mjs";
export { PHOTO_SYSTEM } from "../cloud/web/ai-web.mjs";

export type AiAction = { tool: string; input?: Record<string, unknown> | null; status: string; reason?: string; result?: unknown };
export type AiFileKind = "image" | "pdf" | "audio";
/** A file that goes along (version 2): data is base64 without line breaks. */
export type AiPart = { kind: AiFileKind; mime: string; name: string; data: string };
export type AiReport = {
  answer: string; sent: Array<{ id: string; title: string }>; sources: Array<{ id: string; title: string }>; actions: AiAction[];
  files?: Array<{ name: string; kind: string; bytes: number }>; rounds?: number;
  usage: { input: number; output: number; seconds?: number }; stop: string; error?: { code: string; message: string; detail: string };
};
export type AiChange = { tool: string; input: Record<string, unknown>; note: { id: string; title: string; text: string; labels: string[] }; newLabels?: string[] };
type Executor = Record<string, (input: never) => Promise<unknown>>;
type NoteIn = { id: string; title: string; text: string; labels?: string[]; updatedAt?: string; shared?: boolean };

export const runAssistant = run as unknown as (args: {
  request: string; notes: NoteIn[]; labels: string[]; pinned: string[]; includeShared: boolean;
  settings: { language: string; date: string; timeZone: string };
  config: { provider: string; key: string; model: string; baseUrl: string };
  fetcher: (url: string, init?: RequestInit) => Promise<Response>;
  executor: Executor; confirm: (change: AiChange) => Promise<boolean>; signal: AbortSignal; parts?: AiPart[];
}) => Promise<AiReport>;
export type AiCaps = { image: boolean | "unknown"; pdf: boolean | "unknown"; audio: boolean | "unknown"; transcribe: boolean | "unknown" };
export const capabilities = parts.capabilities as unknown as (provider: string, model: string | { id: string; inputs?: string[] }) => AiCaps;
export const explain = parts.explain as unknown as (provider: string, kind: string, use?: "ask" | "transcribe") => string;
export const LIMITS = parts.LIMITS as { files: number; image: number; pdf: number; audio: number; total: number };
export const decodedLength = parts.decodedLength as unknown as (data: string) => number;

export type AiReceipt = { title?: string; shop?: string; amount?: string; currency?: string; bought?: string; warrantyUntil?: string };
export const KEEP_YEARS = receipt.KEEP_YEARS as number[];
export const receiptRequest = receipt.receiptRequest as unknown as (language: string) => { system: string; text: string };
export const parseReceipt = receipt.parseReceipt as unknown as (answer: string) => AiReceipt | null;
export const keepUntil = receipt.keepUntil as unknown as (bought: string | undefined, years: number) => string;
export const receiptLines = web.receiptLines as unknown as (receipt: AiReceipt) => string;
export const fileRequest = web.fileRequest as unknown as (kind: "photo" | "transcribe") => string;
export const aiFileKind = web.aiFileKind as unknown as (path: string) => { kind: AiFileKind; mime: string } | null;
export const plainBase64 = web.plainBase64 as unknown as (value: string) => string;
export const joinNote = join as unknown as (parts: { front: string; title: string; body: string }) => string;
export const selectNotes = select as unknown as (notes: NoteIn[], question: string, options: { includeShared: boolean; pinned: string[] }) => { notes: Array<{ id: string; title: string; truncated: boolean }> };
export const parseMarkdown = parse as unknown as (text: string) => Array<{ kind: string; level: number; spans: Array<{ text: string; bold: boolean; italic: boolean; code: boolean }> }>;
export const foldUnchanged = fold as unknown as (lines: Array<{ type: string; text: string; sign: string }>) => Array<{ type: string; text?: string; sign?: string; count?: number }>;
export const splitNote = split as unknown as (text: string) => { front: string; title: string; body: string };

type Items = { text?: string; items?: string[] };
export const newNoteText = web.newNoteText as unknown as (note: Items & { title: string; color?: string; label?: string }) => string;
export const appendedText = web.appendedText as unknown as (text: string, add: Items) => string;
export const replacedText = web.replacedText as unknown as (text: string, newText: string) => string;
export const expiryChanges = web.expiryChanges as unknown as (text: string, date: string, drawer?: string) => { expires: string; jotdrop_labels: string[]; reminder?: string };
export const describeChange = web.describeChange as unknown as (change: AiChange) => { heading: string; lines?: Array<{ type: string; text: string; sign: string }>; facts?: Array<[string, string]> };
export const editorRequest = web.editorRequest as unknown as (kind: string, title: string) => string;
export const modelGroups = web.modelGroups as unknown as <M extends { id: string; name: string }>(provider: string, models: M[], preferred: string | null) => Array<{ label: string; models: M[] }>;

// Version 2, phase 7: duplicate notes and the week overview. The code is the shared code (cloud/shared/similar.mjs and
// cloud/shared/ai/digest.mjs, the same on the web and in Android); this file only states the types.
type OverviewNote = { id: string; title: string; text: string; updatedAt?: string; reminder?: string; expires?: string; shared?: boolean };
export type DuplicatePair = { a: string; b: string; kind: "same" | "near" | "inside"; score: number; drop: string };
export const findDuplicates = similar as unknown as (notes: OverviewNote[], options?: { dismissed?: string[] }) => { pairs: DuplicatePair[]; complete: boolean };
export const pairKey = pairs as unknown as (first: string, second: string) => string;
export const diffLines = diff as unknown as (before: string, after: string) => Array<{ type: string; text: string }> | null;
export type WeekDigest = { notes: Array<{ id: string; title: string }>; text: string; left: number; truncated: boolean; counts: { changed: number; reminders: number; expiring: number } };
export const weekDigest = digest as unknown as (notes: OverviewNote[], options: { now?: Date; timeZone: string; includeShared: boolean }) => WeekDigest;
export const digestRequest = digestAsk as unknown as (args: { language: string; date: string; timeZone: string; text: string }) => { system: string; text: string };

// Version 2, phase 8: one key on all your devices (JotDrop Plus). The rules are the shared code (cloud/shared/ai/keysync.mjs,
// the same in the web app; Android has them in Kotlin against the same vectors); this file only states the types.
export type SharedKey = { provider: string; key: string; model: string; baseUrl: string };
export type KeyRemote = { status: "found"; updatedAt: number; config: SharedKey | null } | { status: "none" | "plus" | "unavailable" };
export type KeyAction = "offer" | "available" | "update" | "remove" | "waiting" | "none";
/** What keysync.mjs needs of a connection: CloudClient of the own account, never a shared group's. */
export type KeyClient = { credentials: { vaultKey: string; vaultId: string }; call(path: string, method?: string, body?: unknown): Promise<unknown> };
export const sharedKey = keysync.sharedKey as unknown as (config: unknown) => SharedKey;
export const readSharedKey = keysync.readSharedKey as unknown as (client: KeyClient) => Promise<KeyRemote>;
export const saveSharedKey = keysync.saveSharedKey as unknown as (client: KeyClient, config: unknown) => Promise<number>;
export const removeSharedKey = keysync.removeSharedKey as unknown as (client: KeyClient) => Promise<void>;
export const decideKeySync = keysync.decideKeySync as unknown as (local: { hasKey: boolean; synced: number }, remote: KeyRemote) => KeyAction;
export const sameService = keysync.sameService as unknown as (a: unknown, b: unknown) => boolean;
export const keyLabel = keysync.keyLabel as unknown as (config: unknown) => string;

/**
 * "Merge with AI" (from Find duplicates): both notes go along and the AI writes one text, which the usual confirmation
 * (+ and -) puts in the newer note. Notes are named by id only: a title is data, never part of the request. The same
 * words as mergeRequest in cloud/web/app.js; check:ai-obsidian reads that file and compares.
 */
export function mergeRequest({ older, newer }: { older: { id: string }; newer: { id: string } }): string {
  return `Two notes may be duplicates. The older one has id ${older.id}, the newer one has id ${newer.id}. Write one text that keeps everything from both notes and does not repeat itself, in the language of the notes. Replace the text of the newer note (id ${newer.id}) with that text. Do not change the older note.`;
}

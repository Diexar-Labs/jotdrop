// The shared Ask JotDrop code (cloud/shared/ai and the web app's pure note functions), with the types the plugin
// uses. TypeScript reads the JavaScript itself and guesses too narrow types (optional fields as required, lists as
// never[]); this file only states them, the code is the shared code unchanged.
import { runAssistant as run } from "../cloud/shared/ai/assistant.mjs";
import { selectNotes as select } from "../cloud/shared/ai/context.mjs";
import { parseMarkdown as parse } from "../cloud/shared/ai/markdown.mjs";
import { foldUnchanged as fold } from "../cloud/shared/diff.mjs";
import * as web from "../cloud/web/ai-web.mjs";
import { splitNote as split } from "../cloud/web/note.mjs";
export { AiError, PROVIDERS, createProvider, pickDefaultModel } from "../cloud/shared/ai/providers.mjs";

export type AiAction = { tool: string; input?: Record<string, unknown> | null; status: string; reason?: string; result?: unknown };
export type AiReport = {
  answer: string; sent: Array<{ id: string; title: string }>; sources: Array<{ id: string; title: string }>; actions: AiAction[];
  usage: { input: number; output: number }; stop: string; error?: { code: string; message: string; detail: string };
};
export type AiChange = { tool: string; input: Record<string, unknown>; note: { id: string; title: string; text: string; labels: string[] }; newLabels?: string[] };
type Executor = Record<string, (input: never) => Promise<unknown>>;
type NoteIn = { id: string; title: string; text: string; labels?: string[]; updatedAt?: string; shared?: boolean };

export const runAssistant = run as unknown as (args: {
  request: string; notes: NoteIn[]; labels: string[]; pinned: string[]; includeShared: boolean;
  settings: { language: string; date: string; timeZone: string };
  config: { provider: string; key: string; model: string; baseUrl: string };
  fetcher: (url: string, init?: RequestInit) => Promise<Response>;
  executor: Executor; confirm: (change: AiChange) => Promise<boolean>; signal: AbortSignal;
}) => Promise<AiReport>;
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

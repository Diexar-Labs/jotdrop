// Types for sync.mjs, for the TypeScript of the Obsidian plugin. The code is sync.mjs; this file only states the types.
import type { ChangesPage, CloudClient, SavedObject, SnapshotFile } from "./client.mjs";

/** A file as the cloud knows it, without its content. */
export type SyncObject = { path: string; revision: number; deleted: boolean; hash: string };
export type RemoteEntry = SyncObject & { bytes: () => Promise<Uint8Array> };
export type RemoteIndex = { cursor: number; objects: Record<string, SyncObject>; pending?: Record<string, number> };
export type Baseline = { revision: number; hash: string; deleted: boolean };
export type Seen = Record<string, { size: number; modified: number; hash: string }>;

export type RemoteSide = {
  list(): Promise<RemoteEntry[]>;
  write(path: string, bytes: Uint8Array, baseRevision: number): Promise<SyncObject | SavedObject>;
  delete(path: string, baseRevision: number): Promise<SyncObject | SavedObject>;
  base?(path: string, revision: number): Promise<Uint8Array | null>;
};
export type LocalSide = {
  list(): Promise<Map<string, { size: number; modified: number }>>;
  read(path: string): Promise<Uint8Array>;
  compareAndSet(path: string, expected: Uint8Array | null, replacement: Uint8Array | null): Promise<boolean>;
  conflict(path: string, revision: number, bytes: Uint8Array): Promise<unknown>;
};
export type SyncReport = { uploaded: number; downloaded: number; deleted: number; conflicts: number; skipped: string[] };
export type TimelineFile = { id: string; revision: number; deleted: boolean };
export type RestoreStep = { id: string; delete: true; baseRevision: number } | { id: string; delete?: undefined; revision: number; baseRevision: number };

export const KEPT_BYTES: number;
export const MERGE_BYTES: number;
export function hash(bytes: Uint8Array): Promise<string>;
export function fromHex(value: string): string;
export function isPreserved(name: string): boolean;
export function syncPath(value: string, allowPreserved?: boolean): string;
export function copyName(path: string, suffix: string): string;
export function syncFolder(
  remote: RemoteSide,
  local: LocalSide,
  tracked: Record<string, Baseline>,
  persist: (tracked: Record<string, Baseline>) => unknown,
  options?: { checkActive?: () => void; seen?: Seen; progress?: (done: number, total: number) => void; maxFileBytes?: number },
): Promise<SyncReport>;
export function remoteFiles(
  client: Pick<CloudClient, "listChanges" | "readManifest" | "readPieces">,
  index: RemoteIndex,
  options?: { checkActive?: () => void; save?: () => Promise<unknown>; progress?: (done: number, total: number) => void; skipBad?: (path: string) => boolean },
): Promise<RemoteEntry[]>;
export function conflictOriginal(path: string): string | null;
export function cloudTimeline(client: { listChanges(after?: number): Promise<ChangesPage> }, checkActive?: () => void): Promise<{ steps: string[]; current: TimelineFile[] }>;
export function unavailable<T extends Pick<SnapshotFile, "id" | "revision" | "locked" | "cleared">>(current: TimelineFile[], then: T[]): T[];
export function restorePlan(current: TimelineFile[], then: Array<Pick<SnapshotFile, "id" | "revision" | "deleted" | "locked" | "cleared">>): RestoreStep[];

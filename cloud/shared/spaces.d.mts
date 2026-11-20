// Types for spaces.mjs, for the TypeScript of the Obsidian plugin. The code is spaces.mjs; this file only states the types.
// Server answers are described as far as the plugin reads them; other fields may be present.
import type { CloudAnswer, CloudClient } from "./client.mjs";

/** A shared space the account can open: its id and key. */
export type SpaceKey = { id: string; key: string };
/** One space from the light list: id, sequence and state. */
export type SpaceSummary = { id: string; sequence: number; frozen: boolean; [key: string]: unknown };
export type SpaceMember = { accountId: string; name: string | null; role: string; email?: string; [key: string]: unknown };
export type SpaceInvite = { id: string; claimed: boolean; expiresAt?: string; [key: string]: unknown };
export type SpacePrefs = { finishRemoval?: boolean; [key: string]: unknown };
/** What the server keeps, opened: `key` is null while the key was not saved yet, a name null when it does not open. */
export type SpaceDetails = {
  id: string;
  key: string | null;
  name: string | null;
  members: SpaceMember[];
  prefs: SpacePrefs;
  me: { accountId: string; role?: string; [key: string]: unknown };
  role: string;
  frozen: boolean;
  replacedBy?: string | null;
  unfinished?: boolean;
  canTakeOver?: boolean;
  invites?: SpaceInvite[];
  [key: string]: unknown;
};

export function unreadableFile(error: unknown): boolean;
export function spaceClient(client: CloudClient, spaceId: string, spaceKey: string): CloudClient;
export function createSpace(client: CloudClient, name: string, options?: { replaces?: string; memberName?: string }): Promise<SpaceKey>;
export function listSpaces(client: CloudClient): Promise<SpaceSummary[]>;
export function spaceDetails(client: CloudClient, spaceId: string): Promise<SpaceDetails>;
export function setMemberName(client: CloudClient, space: SpaceKey, name: string): Promise<CloudAnswer>;
export function saveSpacePrefs(client: CloudClient, spaceId: string, prefs: SpacePrefs): Promise<CloudAnswer>;
export function makeInvite(client: CloudClient, space: SpaceKey, inviterName: string, origin?: string): Promise<{ id: string; expiresAt: string; link: string }>;
export function withdrawInvite(client: CloudClient, spaceId: string, inviteId: string): Promise<CloudAnswer>;
export function readInvite(link: string): { id: string; claimToken: string; wrappingKey: string };
export function acceptInvite(client: CloudClient, invite: { id: string; claimToken: string; wrappingKey: string }, memberName: string): Promise<SpaceKey & { inviterName: string }>;
export function removeMember(client: CloudClient, spaceId: string, accountId: string): Promise<CloudAnswer>;
export function leaveSpace(client: CloudClient, spaceId: string): Promise<CloudAnswer>;
/** `about` is a person's account; without it the report is about the group. */
export function reportSpace(client: CloudClient, spaceId: string, report: { reason: string; about?: string; details?: string }): Promise<CloudAnswer>;
export function blockMember(client: CloudClient, spaceId: string, accountId: string): Promise<CloudAnswer>;
export function takeOverSpace(client: CloudClient, spaceId: string): Promise<CloudAnswer>;
export function deleteSpace(client: CloudClient, spaceId: string): Promise<CloudAnswer>;
export function writeUnderFreeName(target: CloudClient, path: string, bytes: Uint8Array): Promise<string>;
export function copyCurrentFiles(from: CloudClient, to: CloudClient, seen?: Map<string, { revision: number; path?: string }>): Promise<Map<string, { revision: number; path?: string }>>;
export function replaceSpace(client: CloudClient, space: SpaceKey & { name?: string | null }, options?: { memberName?: string; attempts?: number }): Promise<SpaceKey>;

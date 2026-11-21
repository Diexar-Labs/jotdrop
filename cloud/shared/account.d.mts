// Types for account.mjs, for the TypeScript of the Obsidian plugin. The code is account.mjs; this file only states the types.
import type { CloudAnswer, CloudClient, Fetcher } from "./client.mjs";

type WithFetcher = { fetcher?: Fetcher };
type Connected = { client: CloudClient; recoveryCode: string };

export type Kdf = { salt: string; memory: number; passes: number; parallelism: number };
export type SignupPending = { url: string; signupId: string; vaultKey: string; recoveryToken: string; deviceToken: string };
export type LoginPending = { url: string; challengeId: string; secondFactor: string; unlockKey: string; deviceToken: string };
export type ResetPending = { url: string; resetId: string };
export type ApprovalPending = { url: string; approvalId: string; expiresAt: string; claimToken: string; privateKey: CryptoKey; words: string[] };
export type Approved = ApprovalPending & { vaultId: string; vaultKey: string };
/** Who signed in with Google or GitHub, and whether that address has an account (with a password). */
export type ProviderSignIn = { url: string; ticket: string; verifier: string; provider: string; email: string; account: boolean; password?: boolean };
export type AccountInfo = { email: string; password: boolean; totp: boolean };
export type WaitingDevice = { id: string; publicKey: string; words: string[]; [key: string]: unknown };

export const DEFAULT_KDF: Readonly<{ memory: number; passes: number; parallelism: number }>;
export function deriveKeys(value: string, kdf: Kdf): Promise<{ authKey: string; unlockKey: string }>;
export function signUp(options: { url: string; email: string; password: string; deviceName: string; newsletter?: boolean; human?: string; fetcher?: Fetcher }): Promise<SignupPending>;
export function attachAccount(client: CloudClient, options: { email: string; password: string; newsletter?: boolean }): Promise<{ url: string; signupId: string; vaultId: string }>;
export function confirmSignup(pending: SignupPending, code: string, options?: WithFetcher): Promise<Connected>;
export function confirmSignup(pending: { url: string; signupId: string; vaultId: string }, code: string, options?: WithFetcher): Promise<{ vaultId: string }>;
export function logIn(options: { url: string; email: string; password: string; deviceName: string; fetcher?: Fetcher }): Promise<LoginPending>;
export function confirmLogin(pending: LoginPending, code: string, options?: WithFetcher & { replaceDeviceId?: string }): Promise<CloudClient>;
export function accountInfo(client: CloudClient): Promise<AccountInfo>;
export function changePassword(client: CloudClient, options: { currentPassword: string; newPassword: string; signOutOtherDevices?: boolean }): Promise<CloudAnswer>;
export function newRecoveryCode(client: CloudClient, options?: { password?: string }): Promise<string>;
export function deleteAccount(client: CloudClient, options?: { password?: string }): Promise<CloudAnswer>;
/** `qr` is the QR code as rows of dark and light modules. */
export function setupTotp(client: CloudClient): Promise<{ secret: string; qr: string[] }>;
export function enableTotp(client: CloudClient, options: { password: string; code: string }): Promise<CloudAnswer>;
export function disableTotp(client: CloudClient, options: { password: string }): Promise<CloudAnswer>;
export function startReset(options: { url: string; email: string; fetcher?: Fetcher }): Promise<ResetPending>;
export function resetWithRecoveryCode(reset: ResetPending, options: { code: string; recoveryCode: string; newPassword: string; deviceName: string; replaceDeviceId?: string }, more?: WithFetcher): Promise<CloudClient>;
export function verificationWords(publicKey: string): Promise<string[]>;
export function requestApproval(reset: ResetPending, code: string, options?: WithFetcher): Promise<ApprovalPending>;
export function startProviderSignIn(options: { url: string; provider: string; client: string }): Promise<{ verifier: string; href: string }>;
export function availableProviders(url: string, options?: WithFetcher): Promise<string[]>;
export function personCheckKey(url: string, options?: WithFetcher): Promise<string | null>;
export function providerTicket(options: { url: string; ticket: string; verifier: string; fetcher?: Fetcher }): Promise<ProviderSignIn>;
export function providerSignUp(signIn: ProviderSignIn, options: { deviceName: string; newsletter?: boolean }, more?: WithFetcher): Promise<Connected>;
export function providerApproval(signIn: ProviderSignIn, options?: WithFetcher): Promise<ApprovalPending>;
export function providerRecover(signIn: ProviderSignIn, options: { recoveryCode: string; deviceName: string; replaceDeviceId?: string }, more?: WithFetcher): Promise<CloudClient>;
export function checkApproval(pending: ApprovalPending, options?: WithFetcher): Promise<Approved | null>;
export function completeApproval(approved: Approved, options: { newPassword?: string; deviceName: string; replaceDeviceId?: string }, more?: WithFetcher): Promise<CloudClient>;
export function listApprovals(client: CloudClient): Promise<WaitingDevice[]>;
export function approveDevice(client: CloudClient, approval: { id: string; publicKey: string }): Promise<CloudAnswer>;
export function rejectDevice(client: CloudClient, id: string): Promise<CloudAnswer>;
export function startOver(reset: ResetPending, options: { code: string; newPassword: string; deviceName: string }, more?: WithFetcher): Promise<Connected>;

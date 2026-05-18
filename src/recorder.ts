/**
 * Lightweight MediaRecorder wrapper for voice memos. Uses opus/webm on
 * Chromium (Obsidian Electron) — playable in Obsidian's audio player and
 * accepted by the Android side of JotDrop over Syncthing.
 */
export interface RecordResult {
  blob: Blob;
  durationMs: number;
  /** File extension without leading dot (e.g. `webm`, `m4a`). */
  extension: string;
}

const PREFERRED_TYPES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/ogg;codecs=opus",
  "audio/mp4",
];

export class VoiceMemoRecorder {
  private mediaRecorder: MediaRecorder | null = null;
  private stream: MediaStream | null = null;
  private chunks: Blob[] = [];
  private startMs = 0;
  private mimeType = "";

  async start(): Promise<void> {
    if (this.mediaRecorder) throw new Error("Recording already in progress.");
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mime = PREFERRED_TYPES.find((t) => MediaRecorder.isTypeSupported(t)) ?? "";
    this.mimeType = mime;
    this.mediaRecorder = mime
      ? new MediaRecorder(this.stream, { mimeType: mime })
      : new MediaRecorder(this.stream);
    this.chunks = [];
    this.mediaRecorder.addEventListener("dataavailable", (ev) => {
      if (ev.data && ev.data.size > 0) this.chunks.push(ev.data);
    });
    this.mediaRecorder.start();
    this.startMs = performance.now();
  }

  isRecording(): boolean {
    return this.mediaRecorder?.state === "recording";
  }

  /**
   * Stops the recording. Returns `null` if the recording was empty (button
   * double-pressed or < 100ms of input). Tracks are released along every
   * failure path so the system mic LED turns off.
   */
  async stop(): Promise<RecordResult | null> {
    const rec = this.mediaRecorder;
    const stream = this.stream;
    if (!rec || !stream) {
      this.releaseTracks();
      return null;
    }
    const durationMs = performance.now() - this.startMs;
    const result = await new Promise<RecordResult | null>((resolve) => {
      rec.addEventListener("stop", () => {
        if (this.chunks.length === 0) {
          resolve(null);
          return;
        }
        const type = rec.mimeType || this.mimeType || "audio/webm";
        const blob = new Blob(this.chunks, { type });
        resolve({ blob, durationMs, extension: extensionFromMime(type) });
      }, { once: true });
      try {
        rec.stop();
      } catch {
        resolve(null);
      }
    });
    this.releaseTracks();
    this.mediaRecorder = null;
    this.stream = null;
    this.chunks = [];
    return result;
  }

  /** Discards an in-progress recording — use on navigation away / view close. */
  discard(): void {
    if (this.mediaRecorder) {
      try { this.mediaRecorder.stop(); } catch { /* ignore */ }
    }
    this.releaseTracks();
    this.mediaRecorder = null;
    this.stream = null;
    this.chunks = [];
  }

  private releaseTracks(): void {
    this.stream?.getTracks().forEach((t) => {
      try { t.stop(); } catch { /* ignore */ }
    });
  }
}

function extensionFromMime(mime: string): string {
  const base = mime.split(";")[0].trim().toLowerCase();
  if (base.includes("webm")) return "webm";
  if (base.includes("ogg")) return "ogg";
  if (base.includes("mp4") || base.includes("m4a") || base.includes("aac")) return "m4a";
  if (base.includes("mpeg")) return "mp3";
  if (base.includes("wav")) return "wav";
  return "webm";
}

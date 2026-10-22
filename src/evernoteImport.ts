import { ImportFiles, importFileName, withFrontmatter } from "./keepImport";
import { neutralizeInlineHashtags, readLabels } from "./metadata";

/**
 * Evernote exports (.enex, one file per notebook): XML with one <note> per note,
 * the text as ENML (XHTML) and the attachments inline as base64 <resource>s,
 * which the text points to by the MD5 of their bytes (<en-media hash>).
 */
export interface EvernoteNote {
  source: string;
  title: string;
  content: XmlElement;
  tags: string[];
  /** The export file's name, which Evernote sets to the notebook name; becomes a label. */
  notebook: string;
  createdMs: number;
  editedMs: number;
  /** Import keys of the attachments that were found, in order. */
  attachments: string[];
  /** Import key per MD5 hash, for the <en-media> references. */
  media: Map<string, string>;
  /** Attachments the text never shows; they go at the end. */
  unplaced: string[];
  missingAttachments: number;
  /** Evernote tasks (Evernote 10), placed where their task group sits in the text. */
  tasks: { group: string; text: string; done: boolean }[];
  sourceUrl: string;
}

export interface XmlElement { name: string; attrs: Record<string, string>; children: XmlNode[] }
type XmlNode = XmlElement | string;

const decoder = new TextDecoder();
const basename = (path: string) => path.slice(path.lastIndexOf("/") + 1);
const VOID = new Set(["br", "hr", "img", "en-todo", "en-media", "input", "meta", "link", "col", "area", "wbr"]);
// HTML entities ENML may use: all of Latin-1 (160-255, in order) and the common others.
const LATIN1 = ("nbsp iexcl cent pound curren yen brvbar sect uml copy ordf laquo not shy reg macr deg plusmn sup2 sup3 " +
  "acute micro para middot cedil sup1 ordm raquo frac14 frac12 frac34 iquest Agrave Aacute Acirc Atilde Auml Aring AElig " +
  "Ccedil Egrave Eacute Ecirc Euml Igrave Iacute Icirc Iuml ETH Ntilde Ograve Oacute Ocirc Otilde Ouml times Oslash Ugrave " +
  "Uacute Ucirc Uuml Yacute THORN szlig agrave aacute acirc atilde auml aring aelig ccedil egrave eacute ecirc euml igrave " +
  "iacute icirc iuml eth ntilde ograve oacute ocirc otilde ouml divide oslash ugrave uacute ucirc uuml yacute thorn yuml").split(" ");
const OTHER_ENTITIES: Record<string, number> = {
  OElig: 338, oelig: 339, Scaron: 352, scaron: 353, Yuml: 376, fnof: 402, circ: 710, tilde: 732, alpha: 945, beta: 946,
  gamma: 947, delta: 948, mu: 956, pi: 960, Omega: 937, omega: 969, ensp: 8194, emsp: 8195, thinsp: 8201, zwnj: 8204,
  zwj: 8205, lrm: 8206, rlm: 8207, ndash: 8211, mdash: 8212, lsquo: 8216, rsquo: 8217, sbquo: 8218, ldquo: 8220,
  rdquo: 8221, bdquo: 8222, dagger: 8224, Dagger: 8225, bull: 8226, hellip: 8230, permil: 8240, prime: 8242, Prime: 8243,
  lsaquo: 8249, rsaquo: 8250, euro: 8364, trade: 8482, larr: 8592, uarr: 8593, rarr: 8594, darr: 8595, harr: 8596,
  minus: 8722, infin: 8734, ne: 8800, le: 8804, ge: 8805, spades: 9824, clubs: 9827, hearts: 9829, diams: 9830,
};
const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'",
  ...Object.fromEntries(LATIN1.map((name, i) => [name, String.fromCharCode(160 + i)])),
  ...Object.fromEntries(Object.entries(OTHER_ENTITIES).map(([name, point]) => [name, String.fromCharCode(point)])),
};
const TAG = /<([A-Za-z_][\w:.-]*)((?:\s+[^\s=/<>]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'<>]+))?)*)\s*(\/?)>/y;
const ATTR = /([^\s=/<>]+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s"'<>]+))?/g;
/** Deeper elements are flattened into their parent, so broken markup cannot exhaust the stack. */
const MAX_DEPTH = 400;

function decodeEntities(text: string): string {
  if (!text.includes("&")) return text;
  return text.replace(/&(#[xX][0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (entity, code: string) => {
    if (code[0] !== "#") return ENTITIES[code] ?? entity;
    const point = /^#x/i.test(code) ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
    return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : entity;
  });
}

/** A forgiving XML reader: enough for ENEX and ENML, never throws on bad markup. */
export function parseXml(text: string): XmlElement {
  const root: XmlElement = { name: "", attrs: {}, children: [] };
  const stack = [root];
  const add = (node: XmlNode) => stack[stack.length - 1].children.push(node);
  const after = (close: string, from: number) => {
    const end = text.indexOf(close, from);
    return end < 0 ? text.length : end + close.length;
  };
  let at = 0;
  while (at < text.length) {
    const lt = text.indexOf("<", at);
    if (lt < 0) { add(decodeEntities(text.slice(at))); break; }
    if (lt > at) add(decodeEntities(text.slice(at, lt)));
    if (text.startsWith("<![CDATA[", lt)) {
      const end = text.indexOf("]]>", lt + 9);
      add(text.slice(lt + 9, end < 0 ? text.length : end));
      at = end < 0 ? text.length : end + 3;
    } else if (text.startsWith("<!--", lt)) at = after("-->", lt + 4);
    else if (text.startsWith("<?", lt)) at = after("?>", lt + 2);
    else if (text.startsWith("<!", lt)) at = after(">", lt + 2);
    else if (text.startsWith("</", lt)) {
      at = after(">", lt + 2);
      const name = text.slice(lt + 2, at - 1).trim().toLowerCase();
      const open = stack.map((element) => element.name).lastIndexOf(name);
      if (open > 0) stack.length = open;
    } else {
      TAG.lastIndex = lt;
      const match = TAG.exec(text);
      if (!match) { add("<"); at = lt + 1; continue; }
      const element: XmlElement = { name: match[1].toLowerCase(), attrs: {}, children: [] };
      for (const [, name, raw] of match[2].matchAll(ATTR)) {
        element.attrs[name.toLowerCase()] = raw === undefined ? "" : decodeEntities(/^["']/.test(raw) ? raw.slice(1, -1) : raw);
      }
      add(element);
      if (!match[3] && !VOID.has(element.name) && stack.length < MAX_DEPTH) stack.push(element);
      at = TAG.lastIndex;
    }
  }
  return root;
}

const elements = (parent: XmlElement | undefined, name: string) =>
  (parent?.children ?? []).filter((node): node is XmlElement => typeof node !== "string" && node.name === name);
const child = (parent: XmlElement | undefined, name: string) => elements(parent, name)[0];
function textOf(node: XmlNode | undefined): string {
  const parts: string[] = [];
  const pending = node === undefined ? [] : [node];
  while (pending.length) {
    const next = pending.pop()!;
    if (typeof next === "string") parts.push(next);
    else for (let i = next.children.length - 1; i >= 0; i--) pending.push(next.children[i]);
  }
  return parts.join("");
}
const field = (parent: XmlElement | undefined, name: string) => textOf(child(parent, name)).trim();

const MD5_K = [
  0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee, 0xf57c0faf, 0x4787c62a, 0xa8304613, 0xfd469501,
  0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be, 0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821,
  0xf61e2562, 0xc040b340, 0x265e5a51, 0xe9b6c7aa, 0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8,
  0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed, 0xa9e3e905, 0xfcefa3f8, 0x676f02d9, 0x8d2a4c8a,
  0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c, 0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70,
  0x289b7ec6, 0xeaa127fa, 0xd4ef3085, 0x04881d05, 0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665,
  0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039, 0x655b59c3, 0x8f0ccc92, 0xffeff47d, 0x85845dd1,
  0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1, 0xf7537e82, 0xbd3af235, 0x2ad7d2bb, 0xeb86d391,
];
const MD5_S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];

/** MD5 as lowercase hex (Web Crypto has no MD5). */
export function md5Hex(bytes: Uint8Array): string {
  const length = bytes.length;
  const full = length - (length % 64);
  const tail = new Uint8Array(length % 64 < 56 ? 64 : 128);
  tail.set(bytes.subarray(full));
  tail[length % 64] = 0x80;
  const tv = new DataView(tail.buffer);
  tv.setUint32(tail.length - 8, (length * 8) >>> 0, true);
  tv.setUint32(tail.length - 4, Math.floor(length / 0x20000000), true);
  const state = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476];
  const words = new Uint32Array(16);
  const run = (view: DataView, offset: number) => {
    for (let j = 0; j < 16; j++) words[j] = view.getUint32(offset + j * 4, true);
    let [a, b, c, d] = state;
    for (let i = 0; i < 64; i++) {
      let f: number, g: number;
      if (i < 16) { f = (b & c) | (~b & d); g = i; }
      else if (i < 32) { f = (d & b) | (~d & c); g = (5 * i + 1) % 16; }
      else if (i < 48) { f = b ^ c ^ d; g = (3 * i + 5) % 16; }
      else { f = c ^ (b | ~d); g = (7 * i) % 16; }
      const sum = (a + f + MD5_K[i] + words[g]) | 0;
      const shift = MD5_S[(i >> 4) * 4 + (i & 3)];
      a = d; d = c; c = b;
      b = (b + ((sum << shift) | (sum >>> (32 - shift)))) | 0;
    }
    state[0] = (state[0] + a) | 0; state[1] = (state[1] + b) | 0;
    state[2] = (state[2] + c) | 0; state[3] = (state[3] + d) | 0;
  };
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let offset = 0; offset < full; offset += 64) run(view, offset);
  for (let offset = 0; offset < tail.length; offset += 64) run(tv, offset);
  return state.map((word) => [0, 8, 16, 24].map((s) => ((word >>> s) & 255).toString(16).padStart(2, "0")).join("")).join("");
}

function fromBase64(text: string): Uint8Array {
  const binary = atob(text.replace(/[^A-Za-z0-9+/=]/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** `20240115T093000Z` (UTC); anything else is unknown. */
function enexTime(value: string): number | undefined {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(value);
  const ms = m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : NaN;
  return ms > 0 ? ms : undefined;
}

const EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg", "image/png": "png", "image/gif": "gif", "image/webp": "webp", "image/svg+xml": "svg",
  "image/heic": "heic", "application/pdf": "pdf", "audio/mpeg": "mp3", "audio/mp4": "m4a", "audio/x-m4a": "m4a",
  "audio/wav": "wav", "audio/x-wav": "wav", "audio/amr": "amr", "audio/ogg": "ogg", "video/mp4": "mp4", "text/plain": "txt",
};

/** The attachment's own name, or one from its hash; never a path or a name Windows refuses. */
function resourceName(fileName: string, mime: string, hash: string): string {
  const extension = EXTENSIONS[mime.toLowerCase()] ?? (mime.split("/")[1]?.replace(/[^a-z0-9]/gi, "") || "bin");
  const name = fileName.replace(/[\p{Cc}\\/:*?"<>|]/gu, "_").trim().replace(/[\s.]+$/, "");
  if (!name) return `evernote-${hash.slice(0, 12)}.${extension}`;
  return /\.[^.]+$/.test(name) ? name : `${name}.${extension}`;
}

/** Obsidian tags cannot hold spaces or punctuation. */
function enexTags(values: string[]): string[] {
  const seen = new Set<string>();
  return values
    .map((value) => value.trim().replace(/^#+/, "").replace(/\s+/g, "-").replace(/[^\p{L}\p{N}\p{M}\p{Extended_Pictographic}_\-/]/gu, ""))
    .filter((tag) => {
      if (!tag || seen.has(tag.toLowerCase())) return false;
      seen.add(tag.toLowerCase());
      return true;
    });
}

function mediaHashes(node: XmlNode): Set<string> {
  const found = new Set<string>();
  const pending = [node];
  while (pending.length) {
    const next = pending.pop()!;
    if (typeof next === "string") continue;
    if (next.name === "en-media" && next.attrs.hash) found.add(next.attrs.hash.toLowerCase());
    pending.push(...next.children);
  }
  return found;
}

const encoder = new TextEncoder();
const NOTE_OPEN = encoder.encode("<note>"), NOTE_CLOSE = encoder.encode("</note>");
const DATA_OPEN = encoder.encode("<data"), DATA_CLOSE = encoder.encode("</data>");
const EXPORT_OPEN = encoder.encode("<en-export");

/** Position of `needle` in `bytes[from, to)`, or -1. */
function findBytes(bytes: Uint8Array, needle: Uint8Array, from: number, to = bytes.length): number {
  for (let i = bytes.indexOf(needle[0], from); i >= 0 && i + needle.length <= to; i = bytes.indexOf(needle[0], i + 1)) {
    let j = 1;
    while (j < needle.length && bytes[i + j] === needle[j]) j++;
    if (j === needle.length) return i;
  }
  return -1;
}

/**
 * The text of one <note> with each attachment's base64 replaced by its index in
 * `ranges` (byte ranges in the file), so a large export is never one big string
 * and attachments are only decoded when needed.
 */
function noteText(bytes: Uint8Array, start: number, end: number): { text: string; ranges: [number, number][] } {
  const ranges: [number, number][] = [];
  let text = "", at = start, search = start;
  for (let open = findBytes(bytes, DATA_OPEN, search, end); open >= 0; open = findBytes(bytes, DATA_OPEN, search, end)) {
    const gt = bytes.indexOf(0x3e, open);
    search = open + DATA_OPEN.length;
    // Only <data ...>...</data>: not <data-...> and not an empty <data/>.
    if (gt < 0 || gt >= end || ![0x20, 0x09, 0x0a, 0x0d, 0x3e].includes(bytes[search]) || bytes[gt - 1] === 0x2f) continue;
    const close = findBytes(bytes, DATA_CLOSE, gt, end);
    if (close < 0) break;
    text += decoder.decode(bytes.subarray(at, gt + 1)) + String(ranges.length);
    ranges.push([gt + 1, close]);
    at = search = close;
  }
  text += decoder.decode(bytes.subarray(at, end));
  return { text: text.replace(/\r\n?/g, "\n"), ranges };
}

function readNote(bytes: Uint8Array, start: number, end: number, files: ImportFiles, source: string, index: number, notebook: string, fallback: number): EvernoteNote | undefined {
  const { text, ranges } = noteText(bytes, start, end);
  const note = child(parseXml(text), "note");
  const content = parseXml(textOf(child(note, "content")));
  const media = new Map<string, string>();
  const attachments: string[] = [];
  let missingAttachments = 0;
  for (const [r, resource] of elements(note, "resource").entries()) {
    const id = field(resource, "data");
    const range = /^\d+$/.test(id) ? ranges[Number(id)] : undefined;
    const decode = () => fromBase64(decoder.decode(bytes.subarray(range![0], range![1])));
    let data: Uint8Array;
    try {
      data = range ? decode() : new Uint8Array();
    } catch {
      data = new Uint8Array();
    }
    if (!data.length) {
      missingAttachments += 1;
      continue;
    }
    const hash = md5Hex(data);
    if (media.has(hash)) continue;
    const name = resourceName(field(child(resource, "resource-attributes"), "file-name"), field(resource, "mime"), hash);
    const key = `${source}#${index + 1}/${r + 1}/${name}`;
    files.set(key, () => Promise.resolve(decode()));
    media.set(hash, key);
    attachments.push(key);
  }
  const shown = mediaHashes(content);
  for (const hash of shown) if (!media.has(hash)) missingAttachments += 1;
  const title = field(note, "title").replace(/\s+/g, " ");
  const tasks = elements(note, "task")
    .sort((a, b) => (field(a, "sortweight") < field(b, "sortweight") ? -1 : field(a, "sortweight") > field(b, "sortweight") ? 1 : 0))
    .map((task) => ({ group: field(task, "taskgroupnotelevelid"), text: field(task, "title").replace(/\s+/g, " "), done: field(task, "taskstatus") === "completed" }))
    .filter((task) => task.text);
  if (!title && !textOf(content).trim() && !attachments.length && !tasks.length) return undefined;
  const created = enexTime(field(note, "created")), updated = enexTime(field(note, "updated"));
  return {
    source: `${source}#${index + 1}`,
    title,
    content,
    tags: enexTags(elements(note, "tag").map((tag) => textOf(tag))),
    notebook,
    createdMs: created ?? updated ?? fallback,
    editedMs: updated ?? created ?? fallback,
    attachments,
    media,
    unplaced: [...media].filter(([hash]) => !shown.has(hash)).map(([, key]) => key),
    missingAttachments,
    tasks,
    sourceUrl: field(child(note, "note-attributes"), "source-url"),
  };
}

/**
 * Converts every note in the picked .enex files and adds a loader per attachment
 * to `files`, so the attachments are written like those of other imports.
 */
export async function parseEnexExport(files: ImportFiles, now = Date.now()): Promise<{ notes: EvernoteNote[]; notebooks: number; failed: string[]; error?: string }> {
  const notes: EvernoteNote[] = [];
  const failed: string[] = [];
  let notebooks = 0;
  let error: string | undefined;
  const fail = (what: string, err: unknown) => {
    failed.push(what);
    error ??= err instanceof Error ? err.message : String(err);
  };
  const sources = [...files.keys()].filter((path) => /\.enex$/i.test(path) && !/(^|\/)(__MACOSX\/|\._)/.test(path));
  for (const source of sources.sort()) {
    const load = files.get(source)!;
    let bytes: Uint8Array;
    try {
      bytes = await load();
    } catch (err) {
      fail(source, err);
      continue;
    }
    if (findBytes(bytes, EXPORT_OPEN, 0) < 0) {
      fail(source, `"${basename(source)}" is not an Evernote export.`);
      continue;
    }
    notebooks += 1;
    const notebook = readLabels(basename(source).replace(/\.enex$/i, ""))[0] ?? "";
    const fallback = load.modified && load.modified > 0 ? load.modified : now;
    let index = 0;
    for (let start = findBytes(bytes, NOTE_OPEN, 0); start >= 0; index++) {
      const close = findBytes(bytes, NOTE_CLOSE, start + NOTE_OPEN.length);
      const end = close < 0 ? bytes.length : close + NOTE_CLOSE.length;
      try {
        const note = readNote(bytes, start, end, files, source, index, notebook, fallback);
        if (note) notes.push(note);
      } catch (err) {
        fail(`${source}#${index + 1}`, err);
      }
      start = findBytes(bytes, NOTE_OPEN, end);
    }
  }
  return { notes, notebooks, failed, error };
}

export function evernoteNoteFileName(note: EvernoteNote): string {
  return importFileName(note.createdMs, note.title || textOf(note.content).split("\n").find((line) => line.trim()) || "Evernote note");
}

// Placeholders while converting, private-use characters (the same characters in
// the note itself are stashed first): line break, paragraph break, an empty line,
// a finished block (stash index between two marks) and a checkbox (x or space).
const mark = (n: number) => String.fromCharCode(0xe000 + n);
const LINE = mark(1), PARA = mark(2), EMPTY = mark(3), STASH = mark(4), TODO = mark(5);
const OWN = new RegExp(`[${LINE}-${TODO}]`, "g");
const MARKS = new RegExp(`[\\n${LINE}-${TODO}]`);
const BREAKS = new RegExp(`[ \\t]*(?:[\\n${LINE}${PARA}][ \\t]*)+`, "g");
const CODE_BREAKS = new RegExp(`[\\n${LINE}]+`, "g");
const EMPTIES = new RegExp(EMPTY, "g");
const CONTENT = new RegExp(`[^\\s${LINE}${PARA}]`);
const SPACES = new RegExp(`[\\s${LINE}${PARA}]+`, "g");
const TODO_START = new RegExp(`^${TODO}(.) *`, "gm");
const TODO_INLINE = new RegExp(`${TODO}(.) *`, "g");
const BLOCKS = new Set(["div", "li", "center", "address", "dl", "dt", "dd", "section", "article", "header", "footer",
  "figure", "figcaption", "nav", "aside", "main", "details", "summary"]);
const style = (node: XmlElement, property: string) => new RegExp(`(^|;)\\s*-?-en-${property}\\s*:\\s*true`).test(node.attrs.style ?? "");
/** `(`, `)`, spaces and angle brackets would end a Markdown link target. */
const encodeUrl = (url: string) => url.replace(/[()\s<>]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`);

/** Plain text that Markdown would read as markup: HTML tags, and block markers at the start of a line. */
function escapeText(text: string): string {
  const escaped = text.replace(/<(?=[A-Za-z/!?])/g, "\\<");
  // A line of only dashes or equals signs would underline the line above as a heading.
  if (/^\s*[-=_*][-=_*\s]*$/.test(escaped)) return escaped.replace(/[-=_*]/, "\\$&");
  return escaped
    .replace(/^(\s*)(#{1,6}(?=\s|$)|>)/, "$1\\$2")
    .replace(/^(\s*\d{1,9})([.)])(?=\s|$)/, "$1\\$2");
}

/** ENML to Markdown; `media` gives the vault name of an attachment by hash, if it was written. */
export function enmlToMarkdown(root: XmlElement, media: (hash: string) => string | undefined, tasks: EvernoteNote["tasks"] = []): string {
  const stash: string[] = [];
  const keep = (text: string, separator: string) => (text ? `${separator}${STASH}${stash.push(text) - 1}${STASH}${separator}` : "");
  const protect = (text: string) => text.replace(OWN, (c) => `${STASH}${stash.push(c) - 1}${STASH}`);
  const expand = (text: string): string => text.replace(new RegExp(`${STASH}(\\d+)${STASH}`, "g"), (_, i: string) => expand(stash[Number(i)]));
  const finish = (text: string) => expand(text
    .replace(BREAKS, (run) => {
      const hard = run.split("\n").length - 1;
      return "\n".repeat(run.includes(PARA) ? Math.max(2, hard) : Math.max(run.includes(LINE) ? 1 : 0, hard));
    })
    .replace(EMPTIES, "")
    .replace(/\n{3,}/g, "\n\n")
    .replace(TODO_START, "- [$1] ")
    .replace(TODO_INLINE, "[$1] ")
    .trim());
  const inline = (nodes: XmlNode[]) => nodes.map(render).join("");
  // A block's trailing <br> ends its line; a block holding only a <br> is an empty line.
  const block = (node: XmlElement) => {
    const text = inline(node.children);
    const trimmed = text.replace(/\n[ \t]*$/, "");
    return CONTENT.test(trimmed) || !text.includes("\n") ? trimmed : EMPTY;
  };
  const wrap = (mark: string, text: string) => {
    const [, lead, body, trail] = /^(\s*)([\s\S]*?)(\s*)$/.exec(text)!;
    return body && !MARKS.test(body) ? `${lead}${mark}${body}${mark}${trail}` : text;
  };
  const checklist = (items: { text: string; done: boolean }[]) =>
    items.map((item) => `- [${item.done ? "x" : " "}] ${item.text}`).join("\n");
  const placedGroups = new Set<string>();

  // Code keeps its spaces (Evernote indents with no-break spaces) and its lines.
  const raw = (node: XmlNode): string => {
    if (typeof node === "string") return protect(node.replace(/\xa0/g, " "));
    if (node.name === "br") return "\n";
    const text = node.children.map(raw).join("");
    if (!BLOCKS.has(node.name) && node.name !== "p" && node.name !== "pre") return text;
    const trimmed = text.replace(/\n$/, "");
    return `${LINE}${trimmed || !text ? trimmed : EMPTY}${LINE}`;
  };
  const fence = (node: XmlElement) => {
    const code = raw(node)
      .replace(CODE_BREAKS, (run) => "\n".repeat(Math.max(run.includes(LINE) ? 1 : 0, run.split("\n").length - 1)))
      .replace(EMPTIES, "")
      .replace(/^\n+|\n+$/g, "");
    const ticks = "`".repeat(Math.max(3, ...Array.from(expand(code).matchAll(/`+/g), (m) => m[0].length + 1)));
    return code ? `${ticks}\n${code}\n${ticks}` : "";
  };

  const list = (node: XmlElement): string => {
    const todo = style(node, "todo");
    let number = Number(node.attrs.start) || 1;
    const lines: string[] = [];
    for (const item of node.children) {
      if (typeof item !== "string" && (item.name === "ul" || item.name === "ol")) {
        lines.push(...list(item).split("\n").map((line) => `\t${line}`));
        continue;
      }
      // Text straight inside the list counts as an item, like a browser shows it.
      const text = finish(typeof item === "string" ? render(item) : inline(item.children));
      if (!text) continue;
      const checked = typeof item !== "string" && style(item, "checked");
      let marker = todo ? `- [${checked ? "x" : " "}] ` : node.name === "ol" ? `${number++}. ` : "- ";
      if (/^- \[[ x]\] /.test(text)) marker = "";
      const [first, ...rest] = text.split("\n");
      lines.push(marker + first, ...rest.map((line) => (line ? `\t${line}` : line)));
    }
    return lines.join("\n");
  };

  const table = (node: XmlElement): string => {
    const rows: string[][] = [];
    let caption = "";
    const walk = (parent: XmlElement) => {
      for (const item of parent.children) {
        if (typeof item === "string") continue;
        if (item.name === "tr") {
          rows.push(item.children.filter((cell): cell is XmlElement => typeof cell !== "string" && (cell.name === "td" || cell.name === "th"))
            .map((cell) => finish(inline(cell.children)).replace(/\n+/g, "<br>").replace(/\|/g, "\\|")));
        } else if (item.name === "caption") caption = finish(inline(item.children)).replace(/\n+/g, " ");
        else if (item.name !== "table") walk(item);
      }
    };
    walk(node);
    const width = Math.max(0, ...rows.map((row) => row.length));
    const line = (cells: string[]) => `| ${Array.from({ length: width }, (_, i) => cells[i] ?? "").join(" | ")} |`;
    const grid = width ? [line(rows[0]), line(Array<string>(width).fill("---")), ...rows.slice(1).map(line)].join("\n") : "";
    return [caption, grid].filter(Boolean).join("\n\n");
  };

  const render = (node: XmlNode): string => {
    if (typeof node === "string") return escapeText(protect(node.replace(/\s+/g, " ")));
    const heading = /^h([1-6])$/.exec(node.name);
    if (heading) return `${LINE}${"#".repeat(Number(heading[1]))} ${inline(node.children).replace(SPACES, " ").trim()}${LINE}`;
    switch (node.name) {
      case "br": return "\n";
      case "hr": return keep("---", PARA);
      case "p": return `${PARA}${block(node)}${PARA}`;
      case "ul": case "ol": return keep(list(node), LINE);
      case "table": return keep(table(node), PARA);
      case "pre": return keep(fence(node), PARA);
      case "blockquote": return keep(finish(inline(node.children)).split("\n").map((line) => (line ? `> ${line}` : ">")).join("\n"), PARA);
      case "en-todo": return `${TODO}${node.attrs.checked === "true" ? "x" : " "}`;
      case "en-media": {
        const name = media((node.attrs.hash ?? "").toLowerCase());
        return name ? `${LINE}![[${name}]]${LINE}` : "";
      }
      // Kept as it is: it can only be decrypted in Evernote, with its password.
      case "en-crypt": {
        const hint = node.attrs.hint ? ` (hint: ${escapeText(protect(node.attrs.hint))})` : "";
        return keep(`Encrypted Evernote text${hint}. Decrypt it in Evernote to read it.\n\n\`\`\`\n${textOf(node).replace(/\s+/g, "")}\n\`\`\``, PARA);
      }
      case "img": {
        const src = (node.attrs.src ?? "").trim();
        return /^https?:\/\//i.test(src) ? `![](${encodeUrl(src)})` : "";
      }
      case "a": {
        const text = inline(node.children);
        const target = (node.attrs.href ?? "").trim();
        const href = encodeUrl(target);
        // Links to other Evernote notes cannot work here; their text stays.
        if (!/^(https?:|mailto:)/i.test(href)) return text;
        // A link around blocks or an image cannot wrap them; its address follows them.
        if (MARKS.test(text) || text.includes("![")) return `${text}${LINE}${href}${LINE}`;
        const [, lead, label, trail] = /^(\s*)([\s\S]*?)(\s*)$/.exec(text)!;
        return `${lead}${!label || label === target || label === href ? href : `[${label.replace(/[[\]]/g, "\\$&")}](${href})`}${trail}`;
      }
      case "b": case "strong": return wrap("**", inline(node.children));
      case "i": case "em": return wrap("*", inline(node.children));
      case "s": case "strike": case "del": return wrap("~~", inline(node.children));
      case "code": {
        const text = textOf(node).replace(/\s+/g, " ");
        const ticks = "`".repeat(Math.max(1, ...Array.from(text.matchAll(/`+/g), (m) => m[0].length + 1)));
        return text.trim() ? `${ticks}${protect(text)}${ticks}` : text;
      }
      case "head": case "style": case "script": case "title": return "";
      case "div": {
        if (style(node, "codeblock")) return keep(fence(node), PARA);
        if (style(node, "task-group")) {
          const group = /--en-id\s*:\s*([^;]+)/.exec(node.attrs.style ?? "")?.[1].trim() ?? "";
          placedGroups.add(group);
          return keep(checklist(tasks.filter((task) => task.group === group)), LINE);
        }
        return `${LINE}${block(node)}${LINE}`;
      }
      case "tr": return `${LINE}${inline(node.children)}${LINE}`;
      case "td": case "th": return `${inline(node.children)} `;
      default: return BLOCKS.has(node.name) ? `${LINE}${block(node)}${LINE}` : inline(node.children);
    }
  };

  const body = inline(root.children);
  const rest = checklist(tasks.filter((task) => !placedGroups.has(task.group)));
  return finish(body + keep(rest, PARA));
}

/** JotDrop Markdown for an Evernote note; `names` maps import keys to vault file names. */
export function evernoteNoteMarkdown(note: EvernoteNote, names: Map<string, string>): string {
  const mediaName = (hash: string) => {
    const key = note.media.get(hash);
    return key ? names.get(key) : undefined;
  };
  const extra = note.unplaced.map((key) => names.get(key)).filter((name): name is string => !!name);
  const text = enmlToMarkdown(note.content, mediaName, note.tasks);
  const url = /^https?:\/\//i.test(note.sourceUrl) ? encodeUrl(note.sourceUrl) : "";
  // Evernote's tags are metadata; a typed hashtag in the text was never a tag there.
  const blocks = [
    note.title ? `# ${neutralizeInlineHashtags(note.title)}` : "",
    neutralizeInlineHashtags(text),
    extra.map((name) => `![[${name}]]`).join("\n\n"),
    url && !text.includes(url) ? url : "",
  ].filter(Boolean);
  return withFrontmatter([
    note.tags.length ? `tags: ${JSON.stringify(note.tags)}` : "",
    note.notebook ? `jotdrop_labels: ${JSON.stringify([note.notebook])}` : "",
  ], blocks.join("\n\n") + "\n");
}

const colors = new Set(['default', 'red', 'orange', 'yellow', 'green', 'teal', 'blue', 'purple', 'pink', 'brown', 'gray']);

function scalar(header, key) {
  const value = new RegExp(`^${key}:[ \\t]*(.*)$`, 'm').exec(header)?.[1].trim() || '';
  if (value.startsWith('"')) { try { return JSON.parse(value); } catch { return ''; } }
  return value.startsWith("'") && value.endsWith("'") ? value.slice(1, -1).replace(/''/g, "'") : value;
}

/** A YAML list in flow (`[a, b]`) or block (`- a`) form; with `words`, also a plain `a b` or `a, b` string. */
function listField(header, key, words = false) {
  const match = new RegExp(`^${key}:[ \\t]*(.*)(?:\\r?\\n|$)`, 'm').exec(header);
  let items = [];
  if (match?.[1].trim().startsWith('[')) {
    try { items = JSON.parse(match[1]); } catch {
      // Unquoted flow lists such as [a, b], as Obsidian writes tags.
      items = words ? match[1].trim().replace(/^\[|\]$/g, '').split(',').map((item) => item.trim().replace(/^(["'])(.*)\1$/, '$2')) : [];
    }
  } else if (match?.[1].trim()) {
    if (words) items = match[1].trim().replace(/^(["'])(.*)\1$/, '$2').split(/[\s,]+/);
  } else if (match) {
    const rest = header.slice(match.index + match[0].length);
    for (const line of rest.split(/\r?\n/)) {
      const item = /^\s+-\s+(.+)$/.exec(line);
      if (!item) break;
      const value = item[1].trim();
      if (value.startsWith('"')) { try { items.push(JSON.parse(value)); } catch { /* Preserve but don't interpret complex YAML. */ } }
      else items.push(value.startsWith("'") && value.endsWith("'") ? value.slice(1, -1).replace(/''/g, "'") : value);
    }
  }
  if (!Array.isArray(items)) return [];
  const unique = new Map();
  for (const item of items) if (typeof item === 'string' && item.trim() && !/[\x00-\x1f]/.test(item)) unique.set(item.trim().toLowerCase(), item.trim());
  return [...unique.values()];
}

/** Interpret only JotDrop's fields; other YAML stays opaque. */
export function noteSummary(text, path) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  const header = match?.[1] || '';
  const body = match ? text.slice(match[0].length) : text;
  const title = /^#\s+(.+)$/m.exec(body)?.[1] || path.split('/').pop().replace(/\.md$/i, '');
  const labels = listField(header, 'jotdrop_labels');
  // Frontmatter tags only, like the plugin editor; inline #hashtags stay in the text.
  const tags = [...new Set(listField(header, 'tags', true).map((tag) => tag.replace(/^#/, '')).filter(Boolean))];
  // Inline #hashtags count as tags too, as Android's InlineTags.find: outside code, not `\#shared`, never digits only.
  const seen = new Set(tags.map((tag) => tag.toLowerCase()));
  const inlineTags = [...body.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]+`/g, ' ').matchAll(/(?:^|(?<=\s))#([\p{L}\p{N}_/-]+)/gmu)]
    .map((match) => match[1]).filter((tag) => /\D/.test(tag) && !seen.has(tag.toLowerCase()) && seen.add(tag.toLowerCase()));
  const color = scalar(header, 'color');
  const order = scalar(header, 'order');
  return { title, body, preview: body.replace(/^\s*#\s+.+(?:\r?\n|$)/, '').trim(), labels, tags, inlineTags, color: colors.has(color) ? color : 'default', pinned: /^(true|yes|on|1)$/i.test(scalar(header, 'pinned')), reminder: scalar(header, 'reminder'), repeat: scalar(header, 'reminder_repeat'), until: scalar(header, 'reminder_until'), limit: scalar(header, 'reminder_limit'), order: order && Number.isFinite(Number(order)) ? Number(order) : undefined };
}

export function updateMetadata(text, changes) {
  const allowed = new Set(['color', 'pinned', 'jotdrop_labels', 'tags', 'order', 'reminder', 'reminder_repeat', 'reminder_until', 'reminder_limit', 'reminder_done']);
  if (Object.keys(changes).some((key) => !allowed.has(key))) throw new Error('Unsupported note property.');
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!match && /^---\r?\n/.test(text)) throw new Error('Close the YAML frontmatter before changing note properties.');
  const newline = match?.[0].includes('\r\n') ? '\r\n' : '\n';
  const lines = match ? match[1].split(/\r?\n/) : [];
  const kept = [];
  let skip = false;
  for (const line of lines) {
    const key = /^([\w]+):/.exec(line)?.[1];
    if (key) skip = Object.hasOwn(changes, key);
    else if (line && !/^\s|^-\s/.test(line)) skip = false;
    if (!skip) kept.push(line);
  }
  for (const [key, value] of Object.entries(changes)) if (value !== null) {
    if (key === 'color' && !colors.has(value)) throw new Error('Choose a supported note color.');
    kept.push(`${key}: ${JSON.stringify(value)}`);
  }
  return (kept.length ? `---${newline}${kept.join(newline)}${newline}---${newline}` : '') + (match ? text.slice(match[0].length) : text);
}

/** Plain card text, as the plugin shows it: no emphasis, code, quote, rule, table or escape marks. */
export function plainPreviewText(text) {
  const lines = [];
  let fence = '';
  for (const line of text.split('\n')) {
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) { if (!fence) fence = marker; else if (marker[0] === fence[0] && marker.length >= fence.length) fence = ''; continue; }
    if (fence) { lines.push(line); continue; }
    if (/^\s{0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/.test(line) || /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)+\|?\s*$/.test(line)) continue;
    // A quoted checklist keeps its `>`, as in the plugin, where it must not become a checkbox.
    const unquoted = line.replace(/^(?:\s{0,3}>[ \t]?)+/, '');
    const plain = (unquoted !== line && /^\s*[-*+][ \t]+\[[ xX]\]/.test(unquoted) ? line : unquoted).replace(/^\[![\w-]+\][+-]?[ \t]*/, '');
    lines.push(/^\s*\|.*\|\s*$/.test(plain)
      ? (plain.match(/(?:\\.|[^|\\])+/g) || []).map((cell) => cell.trim()).filter(Boolean).map(stripInlineMarks).join(' · ')
      : stripInlineMarks(plain));
  }
  return lines.join('\n');
}

function stripInlineMarks(text) {
  return text.replace(/\\([!-/:-@[-`{-~])|(`+)([^`\n]+?)\2|(\*{3}|_{3}|\*\*|__|~~|==)(?=\S)(.*?\S)\4|(^|[^\w*])\*(?=[^\s*])([^*\n]*?[^\s*])\*(?!\*)|(^|[^\w_])_(?=[^\s_])([^_\n]*?[^\s_])_(?!\w)|<br\s*\/?>/gi,
    (_whole, escaped, _ticks, code, _strong, strongText, starLead, starText, underLead, underText) => {
      if (escaped !== undefined) return escaped;
      if (code !== undefined) return code;
      if (strongText !== undefined) return stripInlineMarks(strongText);
      if (starText !== undefined) return starLead + stripInlineMarks(starText);
      if (underText !== undefined) return underLead + stripInlineMarks(underText);
      return ' ';
    });
}

export function toggleTask(text, lineIndex, checked) {
  const lines = text.split('\n');
  if (!/^\s*[-*+] \[[ xX]\] /.test(lines[lineIndex] || '')) throw new Error('This checklist changed. Reopen the current note.');
  lines[lineIndex] = lines[lineIndex].replace(/^(\s*[-*+] \[)[ xX](\] )/, `$1${checked ? 'x' : ' '}$2`);
  return lines.join('\n');
}

export function attachmentPath(target, notePath, available) {
  try { target = decodeURIComponent(target.split('|')[0]); } catch { return; }
  if (!target || /[\\\x00-\x1f:?#]/.test(target) || target.startsWith('/')) return;
  const paths = new Set(available);
  const parts = notePath.split('/').slice(0, -1);
  for (const part of target.split('/')) {
    if (part === '..') { if (!parts.length) return; parts.pop(); }
    else if (part !== '.') parts.push(part);
  }
  const relative = parts.join('/');
  if (paths.has(relative)) return relative;
  if (target.startsWith('attachments/') && paths.has(target)) return target;
  if (!target.includes('/')) {
    const matches = [...paths].filter((path) => path.split('/').pop() === target);
    if (matches.length === 1) return matches[0];
  }
}

/** The editor's view of a note, like the plugin: frontmatter kept as is, an optional `# title`, then the text. */
export function splitNote(text) {
  const front = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.exec(text)?.[0] || '';
  const rest = text.slice(front.length);
  const heading = /^#[ \t]+(.*?)[ \t]*(?:\r?\n|$)(?:[ \t]*\r?\n)?/.exec(rest);
  return heading ? { front, title: heading[1], body: rest.slice(heading[0].length) } : { front, title: '', body: rest };
}

export function joinNote({ front, title, body }) {
  const line = title.replace(/[\r\n]+/g, ' ').trim();
  return front + (line ? `# ${line}\n\n` : '') + body;
}

/** The plugin's and Android's filename for a new note: `<yyyy-MM-dd HHmmss> <first words>.md`. */
/** Manual card order, like the plugin and Android: `order`, else the filename's time stamp (newest first), else 0. */
export function manualRank(order, path) {
  if (order !== undefined) return order;
  const stamp = /^(\d{4})-(\d{2})-(\d{2}) (\d{6})/.exec(path.split('/').pop());
  return stamp ? -Number(stamp.slice(1).join('')) : 0;
}

/** The `order` for a card dropped between two ranks (null at an edge), like the plugin; null when no number fits between them. */
export function betweenRank(prev, next) {
  if (prev === null) return next === null ? 0 : next - 1;
  if (next === null) return prev + 1;
  const middle = prev + (next - prev) / 2;
  return middle > prev && middle < next ? middle : null;
}

export function noteFilename(text, date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  const stamp = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  const { title, body } = splitNote(text);
  // Like the plugin: the first content line, skipping blank lines and whole-line embeds.
  const first = [title, ...body.split('\n')].map((line) => line.trim()).find((line) => line && !/^!\[\[[^\r\n]*\]\]$|^!\[[^\]]*\]\([^)]*\)$/.test(line)) || '';
  const slug = first.replace(/^- \[[ xX]\]\s*/, '').replace(/[#*_`>[\]()]/g, '').replace(/[\/:*?"<>|]/g, '').trim().slice(0, 40).trim();
  return `${slug ? `${stamp} ${slug}` : stamp}.md`;
}

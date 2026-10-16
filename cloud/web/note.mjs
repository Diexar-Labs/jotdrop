const colors = new Set(['default', 'red', 'orange', 'yellow', 'green', 'teal', 'blue', 'purple', 'pink', 'brown', 'gray']);

function scalar(header, key) {
  const value = new RegExp(`^${key}:[ \\t]*(.*)$`, 'm').exec(header)?.[1].trim() || '';
  if (value.startsWith('"')) { try { return JSON.parse(value); } catch { return ''; } }
  return value.startsWith("'") && value.endsWith("'") ? value.slice(1, -1).replace(/''/g, "'") : value;
}

/** Interpret only JotDrop's fields; other YAML stays opaque. */
export function noteSummary(text, path) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  const header = match?.[1] || '';
  const body = match ? text.slice(match[0].length) : text;
  const title = /^#\s+(.+)$/m.exec(body)?.[1] || path.split('/').pop().replace(/\.md$/i, '');
  const labelMatch = /^jotdrop_labels:[ \t]*(.*)(?:\r?\n|$)/m.exec(header);
  let labels = [];
  if (labelMatch?.[1].trim().startsWith('[')) {
    try { labels = JSON.parse(labelMatch[1]); } catch { /* Noncanonical YAML stays intact in the editor. */ }
  } else if (labelMatch) {
    const rest = header.slice(labelMatch.index + labelMatch[0].length);
    for (const line of rest.split(/\r?\n/)) {
      const item = /^\s+-\s+(.+)$/.exec(line);
      if (!item) break;
      const value = item[1].trim();
      if (value.startsWith('"')) { try { labels.push(JSON.parse(value)); } catch { /* Preserve but don't interpret complex YAML. */ } }
      else labels.push(value.startsWith("'") && value.endsWith("'") ? value.slice(1, -1).replace(/''/g, "'") : value);
    }
  }
  if (!Array.isArray(labels)) labels = [];
  const unique = new Map();
  for (const label of labels) if (typeof label === 'string' && label.trim() && !/[\x00-\x1f]/.test(label)) unique.set(label.trim().toLowerCase(), label.trim());
  const color = scalar(header, 'color');
  const order = scalar(header, 'order');
  return { title, body, preview: body.replace(/^\s*#\s+.+(?:\r?\n|$)/, '').trim(), labels: [...unique.values()], color: colors.has(color) ? color : 'default', pinned: /^(true|yes|on|1)$/i.test(scalar(header, 'pinned')), reminder: scalar(header, 'reminder'), repeat: scalar(header, 'reminder_repeat'), order: order && Number.isFinite(Number(order)) ? Number(order) : undefined };
}

export function updateMetadata(text, changes) {
  const allowed = new Set(['color', 'pinned', 'jotdrop_labels', 'order', 'reminder', 'reminder_repeat', 'reminder_until', 'reminder_limit', 'reminder_done']);
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

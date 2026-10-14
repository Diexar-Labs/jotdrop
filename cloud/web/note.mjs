const colors = new Set(['default', 'red', 'orange', 'yellow', 'green', 'teal', 'blue', 'purple', 'pink', 'brown', 'gray']);

/** Read JotDrop's scalar/list metadata for display only; never rewrite unknown YAML. */
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
  const color = /^color:\s*([a-z]+)\s*$/m.exec(header)?.[1] || 'default';
  return { title, preview: body.replace(/^\s*#\s+.+(?:\r?\n|$)/, '').trim(), labels: [...unique.values()], color: colors.has(color) ? color : 'default', pinned: /^pinned:\s*true\s*$/m.test(header) };
}

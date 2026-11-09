// Keys never show: not in an error, a log line or a report. The user's own key is hidden by value; the shapes of
// the big providers' keys (sk-..., AIza...) and anything after Bearer or a key header are hidden by pattern.

const HIDDEN = '[hidden]';
const PATTERNS = [
  [/(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{8,}/g, HIDDEN],
  [/AIza[0-9A-Za-z_-]{20,}/g, HIDDEN],
  [/(Bearer\s+)(?!\[hidden\])[^\s"',;]{6,}/gi, `$1${HIDDEN}`],
  [/((?:x-api-key|x-goog-api-key|api[_-]?key|authorization)["']?\s*[:=]\s*["']?)(?!Bearer\b)(?!\[hidden\])[^\s"',;&}]{6,}/gi, `$1${HIDDEN}`],
  [/([?&]key=)(?!\[hidden\])[^&\s"']+/g, `$1${HIDDEN}`],
];

/** The text with every key in it replaced by [hidden]. */
export function redact(value, secrets = []) {
  let text = value instanceof Error ? String(value) : value == null ? '' : String(value);
  for (const secret of secrets) if (typeof secret === 'string' && secret.trim().length >= 6) text = text.split(secret.trim()).join(HIDDEN);
  for (const [pattern, replacement] of PATTERNS) text = text.replace(pattern, replacement);
  return text;
}

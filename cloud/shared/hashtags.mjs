// Text from outside (a clip, a mail, an AI agent) keeps its #words as text, so it never makes tags on its own: the
// same rule as the web clipper (chrome-extension/cloud.mjs) and Android's ShareActivity; a test keeps this one equal
// to the clipper's. `keep` names tags (lower case, without #) that may stay, because the note already had them.
const skipped = /(`{3,}|~{3,})[\s\S]*?\1|`[^`\n]+`|\[\[[^\]\n]*\]\]|\]\([^)\n]*\)|https?:\/\/[^\s<>]+/g;
const hashtag = /(?<![\\\p{L}\p{N}\p{M}_/])#(?=\p{N}*[\p{L}\p{M}_/\p{Extended_Pictographic}-])/gu;
const tagWord = /^[\p{L}\p{N}\p{M}_/\p{Extended_Pictographic}-]+/u;

export function neutralizeInlineHashtags(text, keep = new Set()) {
  const plain = (part) => part.replace(hashtag, (_mark, offset) => (keep.has(tagWord.exec(part.slice(offset + 1))?.[0].toLowerCase()) ? '#' : '\\#'));
  let out = '', at = 0;
  for (const match of text.matchAll(skipped)) {
    out += plain(text.slice(at, match.index)) + match[0];
    at = match.index + match[0].length;
  }
  return out + plain(text.slice(at));
}

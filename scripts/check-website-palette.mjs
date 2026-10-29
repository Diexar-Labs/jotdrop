import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const css = await readFile(new URL('../docs/website-palette.css', import.meta.url), 'utf8');
const colors = Object.fromEntries([...css.matchAll(/--jd-color-([a-z-]+):\s*(#[a-f0-9]{6});/gi)].map((match) => [match[1], match[2]]));
function luminance(hex) {
  const channels = hex.slice(1).match(/../g).map((value) => parseInt(value, 16) / 255).map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return channels.reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0);
}
assert.equal(luminance('#000000'), 0);
assert.equal(luminance('#ffffff'), 1);
for (const [foreground, background] of [['paper', 'night'], ['white', 'night'], ['ink', 'paper'], ['ink', 'white'], ['ink', 'coral'], ['ink', 'apricot'], ['ink', 'gold'], ['ink', 'violet'], ['apricot', 'night'], ['muted', 'paper'], ['muted-dark', 'night']]) {
  const a = luminance(colors[foreground]), b = luminance(colors[background]);
  const contrast = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  assert.ok(contrast >= 4.5, `${foreground}/${background} does not meet WCAG AA normal-text contrast`);
  console.log(`${foreground}/${background}: ${contrast.toFixed(2)}:1`);
}
console.log('Website palette: all intended normal-text combinations pass WCAG AA. Decorative colors are not automatically text colors.');

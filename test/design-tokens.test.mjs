import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
const css = await readFile(new URL('../frontend/design-tokens.css', import.meta.url), 'utf8');
const tokens = text => Object.fromEntries([...text.matchAll(/--([\w-]+):\s*(#[\da-f]+)/g)].map(([, k, v]) => [k, v]));
const split = css.indexOf("html[data-theme='dark']");
const themes = { light: tokens(css.slice(0, split)), dark: tokens(css.slice(split, css.indexOf("[data-tone='blue']"))) };
const luminance = hex => {
  const values = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map(v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return values[0] * 0.2126 + values[1] * 0.7152 + values[2] * 0.0722;
};
for (const [theme, colors] of Object.entries(themes)) test(theme + ' 文字、状态与输入框对比度', () => {
  const ratio = (a, b) => {
    const x = luminance(colors[a]), y = luminance(colors[b]);
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
  };
  const pairs = [];
  for (const fg of ['text', 'secondary', 'muted']) for (const bg of ['surface', 'surface-soft', 'bg']) pairs.push([fg, bg]);
  for (const tone of ['primary', 'success', 'violet', 'cyan', 'warning', 'danger']) pairs.push([tone, tone + '-soft']);
  for (const bg of ['primary', 'primary-hover', 'primary-active']) pairs.push(['on-primary', bg]);
  for (const [fg, bg] of pairs) assert(ratio(fg, bg) >= 4.5, theme + ': ' + fg + '/' + bg + ' = ' + ratio(fg, bg).toFixed(2));
  assert(ratio('control-border', 'surface') >= 3);
});

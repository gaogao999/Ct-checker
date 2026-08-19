/**
 * 共有ページ（Claude Artifact）用に、<body> の中身だけを 1 ファイルにまとめる。
 *   node scripts/build-artifact.mjs
 * 出力: dist/ct-checker.artifact.html
 * 公開側で <!doctype html><head>…</head><body> が付与されるため、
 * ここでは title / style / 本文 / script だけを書き出す。
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

const html = read('index.html');
const body = html.slice(html.indexOf('<body>') + '<body>'.length, html.indexOf('</body>'))
  .replace(/\s*<script src="assets\/app\.js"><\/script>/, '')
  .trim();

const out = [
  '<title>CT Checker</title>',
  '<style>',
  read('assets/styles.css'),
  '</style>',
  body,
  '<script>',
  read('assets/app.js'),
  '</script>',
  ''
].join('\n');

mkdirSync(join(root, 'dist'), { recursive: true });
writeFileSync(join(root, 'dist/ct-checker.artifact.html'), out);
console.log(`dist/ct-checker.artifact.html を書き出しました (${(out.length / 1024).toFixed(1)} KB)`);

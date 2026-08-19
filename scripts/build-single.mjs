/**
 * index.html / assets を 1 枚の HTML にまとめる。
 *   node scripts/build-single.mjs
 * 出力: dist/ct-checker.html （オフラインの現場端末に配りやすい単一ファイル）
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

const css = read('assets/styles.css');
const js = read('assets/app.js');

const html = read('index.html')
  .replace('<link rel="stylesheet" href="assets/styles.css">', () => `<style>\n${css}\n</style>`)
  .replace('<script src="assets/app.js"></script>', () => `<script>\n${js}\n</script>`);

mkdirSync(join(root, 'dist'), { recursive: true });
writeFileSync(join(root, 'dist/ct-checker.html'), html);
console.log(`dist/ct-checker.html を書き出しました (${(html.length / 1024).toFixed(1)} KB)`);

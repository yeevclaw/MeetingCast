import { readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
const option = (name, fallback) => { const i = process.argv.indexOf(name); return i < 0 ? fallback : process.argv[i + 1]; };
const cwd = option('--cwd', process.cwd());
const base = option('--base');
if (!base) { console.error('請提供 --base <git-ref>'); process.exit(1); }
// 先驗證 ref，避免把錯字或 Git 錯誤當成「沒有新增依賴」。
const ref = (await exec('git', ['rev-parse', '--verify', `${base}^{commit}`], { cwd, encoding: 'utf8' })).stdout.trim();
const read = (path) => { try { return readFileSync(`${cwd}/${path}`, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return ''; throw e; } };
const old = async (path) => {
  try { await exec('git', ['cat-file', '-e', `${ref}:${path}`], { cwd }); }
  catch (e) { if (e.code === 128) return ''; throw e; }
  return (await exec('git', ['show', `${ref}:${path}`], { cwd, encoding: 'utf8' })).stdout;
};
function cargo(text) {
  const names = []; let active = false;
  for (const line of text.split('\n')) {
    const section = line.match(/^\s*\[([^\]]+)\]/);
    if (section) {
      const name = section[1];
      active = name === 'dependencies' || /^target\..+\.dependencies$/.test(name);
      const table = name.match(/^(?:dependencies|target\..+\.dependencies)\.([\w-]+)$/);
      if (table) names.push(table[1]);
    } else if (active) {
      const entry = line.match(/^\s*["']?([\w-]+)["']?\s*=/);
      if (entry) names.push(entry[1]);
    }
  }
  return names;
}
const parsers = {
  'src-tauri/Cargo.toml': cargo,
  'package.json': (s) => Object.keys(s.trim() ? JSON.parse(s).dependencies ?? {} : {}),
  'prototype/requirements.txt': (s) => s.split('\n').map((l) => l.trim().match(/^([\w][\w.-]*)(?:\[.*?\])?(?=\s*(?:[<>=!~;@#]|$))/)?.[1]).filter(Boolean),
};
const added = new Set();
for (const [path, parse] of Object.entries(parsers)) {
  const before = new Set(parse(await old(path)).map((n) => n.toLowerCase()));
  for (const name of parse(read(path))) if (!before.has(name.toLowerCase())) added.add(name.toLowerCase());
}
const notices = read('THIRD_PARTY_NOTICES.md').toLowerCase();
const exempt = new Set(read('third_party/notice-exempt.txt').split('\n').filter((l) => !l.trim().startsWith('#')).flatMap((l) => {
  const [name, reason] = l.split('｜'); return name?.trim() && reason?.trim() ? [name.trim().toLowerCase()] : [];
}));
const missing = [...added].filter((n) => !notices.includes(n) && !exempt.has(n));
if (missing.length) { console.error(`新增執行期依賴缺少第三方聲明：\n${missing.join('\n')}`); process.exit(1); }
console.log(`OK：新增執行期依賴 ${added.size} 個均有聲明或豁免`);

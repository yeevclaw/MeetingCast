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
  const entries = new Map(); let active = false; let tableKey;
  for (const line of text.split('\n')) {
    const section = line.match(/^\s*\[([^\]]+)\]/);
    if (section) {
      const name = section[1];
      active = name === 'dependencies' || /^target\..+\.dependencies$/.test(name);
      tableKey = name.match(/^(?:dependencies|target\..+\.dependencies)\.([\w-]+)$/)?.[1];
      if (tableKey) entries.set(tableKey, tableKey);
    } else if (tableKey) {
      const renamed = line.match(/^\s*package\s*=\s*["']([^"']+)["']/);
      if (renamed) entries.set(tableKey, renamed[1]);
    } else if (active) {
      const entry = line.match(/^\s*["']?([\w-]+)["']?(?:\.(workspace|version|package))?\s*=\s*(.*)/);
      if (entry) {
        const [, key, field, value] = entry;
        const renamed = field === 'package' ? value.match(/^["']([^"']+)["']/)
          : value.match(/\bpackage\s*=\s*["']([^"']+)["']/);
        if (renamed) entries.set(key, renamed[1]);
        else if (!entries.has(key)) entries.set(key, key);
      }
    }
  }
  return [...entries.values()];
}
const parsers = {
  'src-tauri/Cargo.toml': cargo,
  'package.json': (s) => Object.keys(s.trim() ? JSON.parse(s).dependencies ?? {} : {}),
  'prototype/requirements.txt': (s) => s.split('\n').map((l) => l.trim().match(/^([\w][\w.-]*)(?:\[.*?\])?(?=\s*(?:[<>=!~;@#]|$))/)?.[1]).filter(Boolean).map((name) => name.toLowerCase().replace(/[-_.]+/g, '-')),
};
const added = new Set();
for (const [path, parse] of Object.entries(parsers)) {
  const before = new Set(parse(await old(path)).map((n) => n.toLowerCase()));
  for (const name of parse(read(path))) if (!before.has(name.toLowerCase())) added.add(name.toLowerCase());
}
const notices = [...read('THIRD_PARTY_NOTICES.md').matchAll(/^## (.+)$/gm)].map((m) => m[1].toLowerCase().replace(/_/g, '-'));
const hasNotice = (name) => {
  const escaped = name.replace(/_/g, '-').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return notices.some((heading) => new RegExp(`\\b${escaped}\\b`).test(heading));
};
const exempt = new Set(read('third_party/notice-exempt.txt').split('\n').filter((l) => !l.trim().startsWith('#')).flatMap((l) => {
  const [name, reason] = l.split('｜'); return name?.trim() && reason?.trim() ? [name.trim().toLowerCase()] : [];
}));
const missing = [...added].filter((n) => !hasNotice(n) && !exempt.has(n));
if (missing.length) { console.error(`新增執行期依賴缺少第三方聲明：\n${missing.join('\n')}`); process.exit(1); }
console.log(`OK：新增執行期依賴 ${added.size} 個均有聲明或豁免`);

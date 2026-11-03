import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, openSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);

const root = fileURLToPath(new URL('../../', import.meta.url));
const run = async (name, args = [], env = {}) => {
  const dir = mkdtempSync(resolve(tmpdir(), 'mc-review-output-'));
  const out = resolve(dir, 'stdout'); const err = resolve(dir, 'stderr');
  const stdout = openSync(out, 'w'); const stderr = openSync(err, 'w');
  try {
    const status = await new Promise((done, reject) => {
      const child = spawn(process.execPath, [resolve(root, `scripts/review-checks/${name}.mjs`), ...args], {
        cwd: root, env: { ...process.env, ...env }, stdio: ['ignore', stdout, stderr],
      });
      child.on('error', reject); child.on('close', done);
    });
    return { status, stdout: readFileSync(out, 'utf8'), stderr: readFileSync(err, 'utf8') };
  } finally { closeSync(stdout); closeSync(stderr); rmSync(dir, { recursive: true, force: true }); }
};
function check(result, code, keyword) {
  assert.equal(result.status, code, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, keyword);
}
function temporary(t) {
  const dir = mkdtempSync(resolve(tmpdir(), 'mc-review-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function put(dir, path, content) {
  mkdirSync(dirname(resolve(dir, path)), { recursive: true });
  writeFileSync(resolve(dir, path), content);
}
const git = (dir, ...args) => exec('git', args, { cwd: dir });
async function repo(t) {
  const dir = temporary(t);
  await git(dir, 'init');
  return dir;
}
const titles = [...readFileSync(resolve(root, '.github/pull_request_template.md'), 'utf8').matchAll(/^## (.+)$/gm)].map((m) => m[1].split('（')[0]);
const good = titles.map((title) => `## ${title}（補充說明）\n本次新增開發流程檢查，對終端使用者無影響，驗證與限制如實記錄。`).join('\n');

test('pr-body：英文舊例失敗、缺段落失敗、中文模板通過（env 與 file）', async (t) => {
  check(await run('pr-body', [], { PR_BODY: 'Bump version 0.1.34 -> 0.1.35 in package.json, tauri.conf.json, Cargo.toml, Cargo.lock.' }), 1, /缺少段落/);
  check(await run('pr-body', [], { PR_BODY: good.replace('## 安全與場景面', '## 其他') }), 1, /缺少段落：安全與場景面/);
  check(await run('pr-body', [], { PR_BODY: good }), 0, /OK/);
  const dir = temporary(t); put(dir, 'body.md', good);
  check(await run('pr-body', ['--file', resolve(dir, 'body.md')]), 0, /OK/);
  const empty = good.replace(/(## 安全與場景面[^\n]*\n)[^\n]+/, '$1<!-- 尚待填寫 -->');
  check(await run('pr-body', [], { PR_BODY: empty }), 1, /段落內容空白/);
  check(await run('pr-body', [], { PR_BODY: 'English only `中文` https://example.com/中文' }), 1, /CJK 字元不足/);
});

test('third-party-notices：新增 ferrous-opencc 缺聲明失敗、補聲明通過', async (t) => {
  const dir = await repo(t);
  put(dir, 'src-tauri/Cargo.toml', '[dependencies]\n');
  await git(dir, 'add', '.');
  // 僅對這次臨時 repo 的 commit 傳入身分，不改任何 Git 設定。
  await git(dir, '-c', 'user.name=Review Test', '-c', 'user.email=review@example.invalid', 'commit', '-m', 'base');
  put(dir, 'src-tauri/Cargo.toml', '[dependencies]\nferrous-opencc = "0.4"\n');
  const args = ['--cwd', dir, '--base', 'HEAD'];
  check(await run('third-party-notices', args), 1, /ferrous-opencc/);
  put(dir, 'THIRD_PARTY_NOTICES.md', 'FERROUS-OPENCC');
  check(await run('third-party-notices', args), 0, /OK/);
  put(dir, 'THIRD_PARTY_NOTICES.md', '');
  put(dir, 'third_party/notice-exempt.txt', '# 註解\nferrous-opencc｜測試豁免理由\n');
  check(await run('third-party-notices', args), 0, /OK/);
  put(dir, 'src-tauri/Cargo.toml', '[target.\'cfg(unix)\'.dependencies]\nnew-runtime = "1"\n[dev-dependencies]\nignored = "1"\n');
  check(await run('third-party-notices', args), 1, /new-runtime/);
});

test('tracked-files：誤追蹤設定失敗、hooks.md 文件通過', async (t) => {
  const dir = await repo(t);
  put(dir, '.claude/skills/x/reference/hooks.md', '合法文件');
  await git(dir, 'add', '.');
  check(await run('tracked-files', ['--cwd', dir]), 0, /OK/);
  put(dir, '.claude/settings.json', '{}');
  await git(dir, 'add', '-f', '.claude/settings.json');
  check(await run('tracked-files', ['--cwd', dir]), 1, /禁止追蹤.*檔案/);
});

test('feature-map：不存在路徑與目錄失敗、現有路徑與真實 repo 通過', async (t) => {
  const dir = temporary(t);
  put(dir, 'map.md', '`src/missing.ts`、`src-tauri`');
  check(await run('feature-map', ['--root', dir, '--file', 'map.md']), 1, /路徑不存在/);
  put(dir, 'src/missing.ts', ''); mkdirSync(resolve(dir, 'src-tauri'));
  check(await run('feature-map', ['--root', dir, '--file', 'map.md']), 0, /OK/);
  check(await run('feature-map'), 0, /OK/);
});

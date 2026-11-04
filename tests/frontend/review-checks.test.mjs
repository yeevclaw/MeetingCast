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
  put(dir, 'THIRD_PARTY_NOTICES.md', '## FERROUS_OPENCC');
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
  const dir = await repo(t);
  put(dir, 'map.md', '`src/missing.ts`、`src-tauri`');
  check(await run('feature-map', ['--root', dir, '--file', 'map.md']), 1, /路徑不存在/);
  put(dir, 'src/missing.ts', ''); put(dir, 'src-tauri/tracked.rs', '');
  await git(dir, 'add', '.');
  check(await run('feature-map', ['--root', dir, '--file', 'map.md']), 0, /OK/);
  check(await run('feature-map'), 0, /OK/);
});


test('third-party-notices：授權全文不是套件標題、標題須符合單字邊界', async (t) => {
  const dir = await repo(t);
  put(dir, 'src-tauri/Cargo.toml', '[dependencies]\n');
  await git(dir, 'add', '.');
  await git(dir, '-c', 'user.name=Review Test', '-c', 'user.email=review@example.invalid', 'commit', '-m', 'base');
  put(dir, 'src-tauri/Cargo.toml', '[dependencies]\nopen = "5"\nwhich = "1"\n');
  put(dir, 'THIRD_PARTY_NOTICES.md', '## Apache License 全文\nopen and which\n## OpenCC\n');
  const args = ['--cwd', dir, '--base', 'HEAD'];
  const result = await run('third-party-notices', args);
  check(result, 1, /open/); assert.match(result.stderr, /which/);
  put(dir, 'THIRD_PARTY_NOTICES.md', '## OPEN 5\n## Which\n');
  check(await run('third-party-notices', args), 0, /OK/);
});

test('third-party-notices：Cargo 點號鍵與改名使用實際套件名稱', async (t) => {
  const dir = await repo(t);
  put(dir, 'src-tauri/Cargo.toml', '[dependencies]\n');
  await git(dir, 'add', '.');
  await git(dir, '-c', 'user.name=Review Test', '-c', 'user.email=review@example.invalid', 'commit', '-m', 'base');
  put(dir, 'src-tauri/Cargo.toml', `[dependencies]
foo.workspace = true
bar.version = "1"
alias = { package = "actual-inline", version = "1" }
renamed.version = "1"
renamed.package = "actual-dotted"
[dependencies.table-alias]
package = "actual-table"
version = "1"
`);
  const args = ['--cwd', dir, '--base', 'HEAD'];
  const result = await run('third-party-notices', args);
  check(result, 1, /foo/);
  for (const name of ['bar', 'actual-inline', 'actual-dotted', 'actual-table']) assert.match(result.stderr, new RegExp(name));
  assert.doesNotMatch(result.stderr, /table-alias|renamed|\nalias/);
  put(dir, 'THIRD_PARTY_NOTICES.md', ['foo', 'bar', 'actual-inline', 'actual-dotted', 'actual-table'].map((n) => `## ${n}`).join('\n'));
  check(await run('third-party-notices', args), 0, /OK/);
});

test('third-party-notices：requirements 依 PEP 503 正規化後比較 base/head', async (t) => {
  const dir = await repo(t);
  put(dir, 'prototype/requirements.txt', 'Foo_Bar==1\nother...pkg==1\n');
  await git(dir, 'add', '.');
  await git(dir, '-c', 'user.name=Review Test', '-c', 'user.email=review@example.invalid', 'commit', '-m', 'base');
  put(dir, 'prototype/requirements.txt', 'foo-bar==2\nOTHER-pkg==2\n');
  check(await run('third-party-notices', ['--cwd', dir, '--base', 'HEAD']), 0, /依賴 0 個/);
});

test('feature-map：忽略或未追蹤的磁碟檔案不算存在，追蹤目錄前綴可通過', async (t) => {
  const dir = await repo(t);
  put(dir, '.gitignore', 'dist/\n');
  put(dir, 'dist/ignored.js', '');
  put(dir, 'src/untracked.ts', '');
  put(dir, 'map.md', '`dist/ignored.js`、`src/untracked.ts`');
  await git(dir, 'add', '.gitignore');
  const result = await run('feature-map', ['--root', dir, '--file', 'map.md']);
  check(result, 1, /dist\/ignored.js/); assert.match(result.stderr, /src\/untracked.ts/);
  await git(dir, 'add', 'src/untracked.ts');
  put(dir, 'map.md', '`src`、`src/untracked.ts`');
  check(await run('feature-map', ['--root', dir, '--file', 'map.md']), 0, /OK/);
});

test('workflow：描述檢查獨立、取消條件、checkout 憑證與 Rust 資源目錄', () => {
  const checks = readFileSync(resolve(root, '.github/workflows/pr-checks.yml'), 'utf8');
  const body = readFileSync(resolve(root, '.github/workflows/pr-body.yml'), 'utf8');
  assert.match(checks, /types: \[opened, synchronize, reopened\]/);
  assert.doesNotMatch(checks, /PR_BODY|pr-body.mjs/);
  assert.match(body, /types: \[opened, edited, synchronize, reopened\]/);
  assert.doesNotMatch(body, /workflow_dispatch|pull_request_target/);
  assert.match(body, /group: pr-body-/);
  assert.match(body, /contents: read/);
  assert.match(body, /sparse-checkout:[\s\S]*pull_request_template.md/);
  assert.match(body, /env:\n          PR_BODY: \$\{\{ github.event.pull_request.body \}\}\n        run: node scripts\/review-checks\/pr-body.mjs/);
  const review = checks.split('  review-checks:')[1].split('  tests:')[0];
  assert.equal([...review.matchAll(/^      - /gm)].length, [...review.matchAll(/if: \$\{\{ !cancelled\(\) \}\}/g)].length);
  for (const workflow of [checks, body]) {
    for (const step of workflow.split('      - ').filter((s) => s.startsWith('uses: actions/checkout@'))) assert.match(step, /persist-credentials: false/);
    for (const line of workflow.split('\n').filter((l) => /run:/.test(l))) assert.doesNotMatch(line, /\$\{\{/);
  }
  assert.match(checks, /# .*frontendDist[^\n]*\n      - run: mkdir -p dist\n      - run: cargo test --locked/);
});


test('third-party-notices：Cargo alias 改寫但實際套件相同不算新增', async (t) => {
  const dir = await repo(t);
  put(dir, 'src-tauri/Cargo.toml', '[dependencies]\nactual = "1"\nshared = "1"\n');
  await git(dir, 'add', '.');
  await git(dir, '-c', 'user.name=Review Test', '-c', 'user.email=review@example.invalid', 'commit', '-m', 'base');
  put(dir, 'src-tauri/Cargo.toml', '[dependencies]\nalias = { package = "actual", version = "1" }\nshared.workspace = true\n');
  check(await run('third-party-notices', ['--cwd', dir, '--base', 'HEAD']), 0, /依賴 0 個/);
});

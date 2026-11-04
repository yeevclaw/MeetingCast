import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
const arg = process.argv.indexOf('--cwd');
const cwd = arg < 0 ? process.cwd() : process.argv[arg + 1];
const files = (await exec('git', ['ls-files', '-z'], { cwd, encoding: 'utf8' })).stdout.split('\0').filter(Boolean);
const invalid = files.filter((p) => /^(?:\.claude\/settings[^/]*(?:\/|$)|\.claude\/hooks\/|\.codex\/|src-tauri\/binaries\/)|(?:^|\/)hooks\.json$/.test(p));
if (invalid.length) { console.error(`禁止追蹤的檔案：\n${invalid.join('\n')}`); process.exit(1); }
console.log('OK：追蹤檔案符合規範');

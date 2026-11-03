import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
const option = (name, fallback) => { const i = process.argv.indexOf(name); return i < 0 ? fallback : process.argv[i + 1]; };
const root = resolve(option('--root', process.cwd()));
const content = readFileSync(resolve(root, option('--file', 'docs/FEATURE_MAP.md')), 'utf8');
const paths = [...new Set([...content.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]).filter((p) =>
  !/[\s:#<>{}()=]/.test(p) && !p.startsWith('/') && !p.includes('://') &&
  (p.includes('/') || /\.(?:md|mjs|js|jsx|ts|tsx|rs|py|json|jsonl|toml|lock|txt|yml|yaml|css|html|sh|plist)$/i.test(p) || ['src-tauri', 'python-sidecar', 'prototype'].includes(p))
))];
const missing = paths.filter((p) => !existsSync(resolve(root, p)));
if (missing.length) { console.error(`功能地圖路徑不存在：\n${missing.join('\n')}`); process.exit(1); }
console.log(`OK：功能地圖 ${paths.length} 個路徑均存在`);

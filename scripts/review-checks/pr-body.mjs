import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const file = process.argv.indexOf('--file');
const body = (file >= 0 ? readFileSync(process.argv[file + 1], 'utf8') : process.env.PR_BODY ?? '')
  .replace(/<!--[\s\S]*?-->/g, '');
const template = readFileSync(fileURLToPath(new URL('../../.github/pull_request_template.md', import.meta.url)), 'utf8');
const titles = [...template.matchAll(/^## (.+)$/gm)].map((m) => m[1].split('（')[0].trim());
// 程式碼內的標題不能代替真正的 PR 段落。
const prose = body.replace(/^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?^ {0,3}\1[^\n]*(?:\n|$)/gm, '');
const headings = [...prose.matchAll(/^## (.+)$/gm)];
const errors = [];
let previous = -1;
for (const title of titles) {
  const index = headings.findIndex((m) => m[1].trim().startsWith(title));
  if (index < 0) { errors.push(`缺少段落：${title}`); continue; }
  if (index <= previous) errors.push(`段落順序錯誤：${title}`);
  previous = index;
  const start = headings[index].index + headings[index][0].length;
  const end = headings[index + 1]?.index ?? prose.length;
  if (!prose.slice(start, end).replace(/^Fixes\s+#.*$/gm, '').trim()) errors.push(`段落內容空白：${title}`);
}
const count = [...prose.replace(/`+[^`]*`+/g, '').replace(/https?:\/\/[^\s<>]+/g, '').matchAll(/\p{Script=Han}/gu)].length;
if (count < 50) errors.push(`CJK 字元不足 50 個（目前 ${count} 個）`);
if (errors.length) { console.error(errors.map((e) => `- ${e}`).join('\n')); process.exit(1); }
console.log('OK：PR 描述符合模板');

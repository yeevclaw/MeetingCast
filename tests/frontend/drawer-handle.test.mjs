import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const control = await readFile(new URL("../../src/windows/ControlWindow.tsx", import.meta.url), "utf8");
const card = await readFile(new URL("../../src/components/SessionSetupCard.tsx", import.meta.url), "utf8");
const css = await readFile(new URL("../../src/App.css", import.meta.url), "utf8");
const handle = control.match(/<button\b[^>]*aria-controls="session-panel"[^>]*>[\s\S]*?<\/button>/)?.[0] ?? "";
const color = (name) => css.match(new RegExp(`--color-${name}:\\s*(#[0-9a-f]{6})`, "i"))[1];
function luminance(hex) {
  const rgb = hex.slice(1).match(/../g).map((v) => parseInt(v, 16) / 255).map((v) => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
}
function contrast(a, b) {
  const values = [luminance(a), luminance(b)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

test("drawer has one native, labelled control and no old title actions", () => {
  assert.doesNotMatch(control, /收合本場設定 →|← 展開本場設定/);
  assert.equal((control.match(/aria-controls="session-panel"/g) ?? []).length, 1);
  assert.match(handle, /type="button"/);
  assert.match(handle, /aria-expanded=\{!panelCollapsed\}/);
  for (const attr of ["aria-label", "title"]) assert.ok(handle.includes(`${attr}={panelCollapsed ? "展開本場設定" : "收合本場設定"}`));
  for (const heading of card.matchAll(/<h3\b[^>]*>[\s\S]*?<\/h3>/g)) assert.doesNotMatch(heading[0], /<button/);
  const titleRow = card.match(/<div className="mb-2.5 flex items-baseline justify-between">[\s\S]*?<\/div>/)?.[0];
  assert.ok(titleRow);
  assert.doesNotMatch(titleRow, /<button/);
  assert.match(control, /<aside id="session-panel" hidden=\{panelCollapsed\}/);
});

test("collapsed rail is clickable without a second keyboard or screen reader control", () => {
  const rail = control.match(/<div\b[^>]*data-session-rail[^>]*>[\s\S]*?<\/div>/)?.[0] ?? "";
  assert.match(rail, /本場設定/);
  assert.match(rail, /onClick=\{\(\) => setPanelCollapsed\(false\)\}/);
  assert.match(rail, /aria-hidden="true"/);
  assert.doesNotMatch(rail, /tabIndex|<button|role="button"/);
  assert.match(rail, /text-xs/);
  assert.match(control, /grid-cols-\[minmax\(0,1fr\)_36px\]/);
});

test("handle geometry, motion preference and persistence remain explicit", () => {
  assert.match(handle, /absolute.*top-1\/2.*z-20/);
  assert.match(handle, /h-12 w-6/);
  assert.match(handle, /focus-visible:outline-ai-blue/);
  assert.match(handle, /stroke="currentColor"/);
  assert.match(handle, /motion-safe:transition-transform motion-safe:duration-150/);
  assert.match(handle, /panelCollapsed \? "rotate-180" : ""/);
  assert.match(control, /useState\(readSessionPanelCollapsed\)/);
  assert.match(control, /saveSessionPanelCollapsed\(panelCollapsed\)/);
});

test("actual handle border and icon tokens meet WCAG contrast", () => {
  assert.ok(handle);
  const border = color(handle.match(/\bborder-(paper-\d+)/)[1]);
  const icon = color(handle.match(/\btext-(paper-\d+)/)[1]);
  for (const bg of ["paper-0", "paper-50", "paper-100"]) {
    assert.ok(contrast(border, color(bg)) >= 3, `border vs ${bg}`);
    assert.ok(contrast(icon, color(bg)) >= 4.5, `icon vs ${bg}`);
  }
  console.log(`border ${border}; icon ${icon}; contrasts:`, ["paper-0", "paper-50", "paper-100"].map(bg => [bg, contrast(border, color(bg)).toFixed(2), contrast(icon, color(bg)).toFixed(2)]));
});

test("collapsed rail label stacks all four characters without writing-mode", () => {
  const rail = control.match(/<div\b[^>]*data-session-rail[^>]*>[\s\S]*?<\/div>/)?.[0] ?? "";
  assert.doesNotMatch(rail, /writing-mode|whitespace-nowrap/);
  assert.match(rail, /<span className="flex flex-col items-center">/);
  assert.match(rail, /"本場設定"\.split\(""\)\.map\(\(ch\) =>/);
  assert.match(rail, /<span key=\{ch\} className="block leading-\[1\.25\]">\{ch\}<\/span>/);
  assert.match(rail, /py-5 text-xs font-medium text-paper-700/);
});

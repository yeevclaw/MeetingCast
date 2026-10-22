import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";

const source = await readFile(new URL("../../src/lib/sessionPanel.ts", import.meta.url), "utf8");
function load(storage) {
  const context = { exports: {}, localStorage: storage };
  vm.runInNewContext(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS },
  }).outputText, context);
  return context.exports;
}

test("first launch expands; collapse and expand survive a window reload", () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
  const panel = load(storage);
  assert.equal(panel.readSessionPanelCollapsed(), false);
  panel.saveSessionPanelCollapsed(true);
  assert.equal(load(storage).readSessionPanelCollapsed(), true);
  panel.saveSessionPanelCollapsed(false);
  assert.equal(load(storage).readSessionPanelCollapsed(), false);
  assert.equal(values.size, 1);
});

test("invalid stored values default to expanded", () => {
  for (const value of [null, "", "false", "broken", "1"]) {
    assert.equal(load({ getItem: () => value }).readSessionPanelCollapsed(), false);
  }
});

test("unavailable storage does not prevent opening the console or toggling", () => {
  const panel = load({
    getItem: () => { throw new Error("blocked"); },
    setItem: () => { throw new Error("quota"); },
  });
  assert.equal(panel.readSessionPanelCollapsed(), false);
  assert.doesNotThrow(() => panel.saveSessionPanelCollapsed(true));
});

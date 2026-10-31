import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
const settings = read('src/components/SettingsModal.tsx');
const control = read('src/windows/ControlWindow.tsx');
const wizard = read('src/components/WelcomeWizard.tsx');
test('Field associates generated labels and hints with controls', () => {
  assert.ok(/useId\(/.test(settings));
  assert.ok(/htmlFor=/.test(settings));
  assert.ok(/aria-describedby/.test(settings));
  assert.ok(/<p role="status"/.test(settings));
});
test('all three modals expose dialog semantics and focus management', () => {
  for (const source of [settings, control, wizard]) {
    assert.ok(/role="dialog"/.test(source));
    assert.ok(/aria-modal="true"/.test(source));
    assert.ok(/aria-labelledby=/.test(source));
    assert.ok(/useFocusTrap\(/.test(source));
  }
});
test('toast announces updates and has a keyboard close button', () => {
  const toast = control.slice(control.indexOf('{toast && ('), control.indexOf('{showSettings && ('));
  assert.ok(/role=\{toast.kind === "error" \? "alert" : "status"\}/.test(toast));
  assert.ok(/aria-live=/.test(toast));
  assert.ok(/<button[\s\S]*aria-label="關閉"/.test(toast));
});
test('secondary text uses sufficient contrast without changing disabled styles', () => {
  for (const path of ['src/components/SettingsModal.tsx', 'src/components/SessionSetupCard.tsx', 'src/windows/ControlWindow.tsx', 'src/components/WelcomeWizard.tsx']) {
    const source = read(path).replaceAll('disabled:text-paper-500', '');
    assert.ok(!/\btext-paper-500\b/.test(source), path);
  }
});
test('light stage dim token is darker; default dark theme remains unchanged', () => {
  const css = read('src/App.css');
  assert.ok(/\.stage-light\s*\{[^}]*--color-stage-dim:\s*#6e6e73;/.test(css));
  assert.ok(/@theme\s*\{[\s\S]*?--color-stage-dim:\s*#8e8e93;/.test(css));
});
test('restart dialog has its own name, modal state and focus ref', () => {
  const restart = control.slice(control.indexOf('{confirmRestart && ('), control.indexOf('// ---------- Small presentational pieces'));
  assert.ok(/ref=\{restartRef\} role="dialog" aria-modal="true" aria-labelledby=\{restartTitleId\}/.test(restart));
  assert.ok(/<h2 id=\{restartTitleId\}/.test(restart));
});
test('focus trap wraps Tab, guards focus and restores background and trigger', () => {
  const hook = read('src/lib/useFocusTrap.ts');
  for (const pattern of [/useLayoutEffect/, /event.key !== 'Tab'/, /event.shiftKey/, /focusin/, /trigger\.focus\(\)/, /element\.inert = state\.original/]) {
    assert.ok(pattern.test(hook), String(pattern));
  }
});
test('chip relationships, opaque focus and translation hint floor remain present', () => {
  assert.ok(/aria-controls=\{isOpen \? popoverId : undefined\}/.test(control));
  assert.ok(/aria-labelledby=\{titleId\}/.test(control));
  for (const source of [settings, control, read('src/components/SessionSetupCard.tsx')]) {
    assert.ok(!/focus(?:-visible)?:ring-[\w-]+\//.test(source));
  }
  const translation = read('src/windows/TranslationWindow.tsx');
  assert.ok(/focus-visible:outline-stage-fg/.test(translation));
  assert.ok(/max\(14px,/.test(translation));
  assert.ok(!/text-center opacity-70/.test(translation));
});
test('opaque focus color clears 3:1 on every affected control surface', () => {
  const css = read('src/App.css');
  const color = (name) => css.match(new RegExp(`--color-${name}: (#[a-f0-9]{6});`))[1];
  const luminance = (hex) => {
    const linear = hex.slice(1).match(/../g).map((c) => parseInt(c, 16) / 255)
      .map((v) => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
    return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
  };
  const foreground = luminance(color('paper-700'));
  for (const surface of ['paper-0', 'paper-50', 'ok-50', 'warn-50', 'danger-50']) {
    assert.ok((luminance(color(surface)) + 0.05) / (foreground + 0.05) >= 3, surface);
  }
});

test('wizard forward buttons explicitly receive initial focus', () => {
  const footer = wizard.slice(wizard.indexOf('{/* ---- footer ---- */}'));
  const primary = [...footer.matchAll(/<button\b[^>]*className="(?:ai-fill|rounded-xl bg-paper-900)[^>]*>/g)];
  assert.equal(primary.length, 6);
  for (const [button] of primary) assert.match(button, /data-autofocus/);
});
test('checkbox Fields label groups without linking headings to checkboxes', () => {
  for (const label of ['音源', '同步口譯模式（實驗）', '會後自動總結']) {
    const field = [...settings.matchAll(/<Field\b[\s\S]*?<\/Field>/g)].find(([source]) => source.includes(`label="${label}"`))?.[0];
    assert.ok(field, label);
    assert.match(field, /<Field\s+group\b/);
    assert.match(field, /<div[^>]*role="group"[^>]*\{\.\.\.controlProps\}/);
    assert.doesNotMatch(field, /<input\s+\{\.\.\.controlProps\}/);
  }
  const fieldImplementation = settings.slice(settings.indexOf('function Field('));
  assert.match(fieldImplementation, /group \? <span id=/);
  assert.match(fieldImplementation, /"aria-labelledby": group \?/);
  assert.match(fieldImplementation, /"aria-describedby": hint \?/);
});
test('transcript emphasis does not change collapse button inherited weight', () => {
  const header = control.slice(control.lastIndexOf('<div', control.indexOf('即時逐字稿')), control.indexOf('<div ref={historyRef}'));
  assert.match(header, /^<div className="[^"\n]*font-medium/);
  assert.doesNotMatch(header.split('>')[0], /font-semibold/);
  assert.match(header, /<span className="font-semibold">即時逐字稿<\/span>/);
});

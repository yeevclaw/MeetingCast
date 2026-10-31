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
test('transcript heading emphasis is scoped to its label', () => {
  const header = control.slice(control.lastIndexOf('<div', control.indexOf('即時逐字稿')), control.indexOf('<div ref={historyRef}'));
  assert.match(header, /^<div className="[^"\n]*font-medium/);
  assert.doesNotMatch(header.split('>')[0], /font-semibold/);
  assert.match(header, /<span className="font-semibold">即時逐字稿<\/span>/);
});

const css = read('src/App.css');
const cssValue = (name) => {
  const value = css.match(new RegExp(`${name}:\\s*([^;]+);`))?.[1];
  assert.ok(value, `missing CSS property ${name}`);
  return value.trim();
};
const background = (selector) => {
  const block = css.slice(css.indexOf(`${selector} {`)).split('}')[0];
  return block.match(/background:\s*([^;]+);/)[1];
};
const resolveColors = (value) => {
  while (/var\(--[\w-]+\)/.test(value)) {
    value = value.replace(/var\((--[\w-]+)\)/g, (_, name) => cssValue(name));
  }
  return value;
};
const rgb = (hex) => hex.slice(1).match(/../g).map((c) => parseInt(c, 16) / 255);
const whiteContrast = (channels) => {
  const linear = channels.map((v) => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return 1.05 / (linear.reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0) + 0.05);
};
test('actual ai-fill gradient clears white text contrast at stops and sRGB interpolated samples', () => {
  const gradient = resolveColors(background('.ai-fill'));
  assert.match(gradient, /^linear-gradient\(/);
  const stops = [...gradient.matchAll(/#[a-f0-9]{6}/gi)].map(([hex]) => hex);
  assert.equal(stops.length, 3);
  for (const hex of stops) assert.ok(whiteContrast(rgb(hex)) >= 4.5, `${hex}: ${whiteContrast(rgb(hex))}`);
  for (let segment = 0; segment < stops.length - 1; segment++) {
    const start = rgb(stops[segment]);
    const end = rgb(stops[segment + 1]);
    for (let sample = 0; sample <= 100; sample++) {
      const channels = start.map((v, i) => v + (end[i] - v) * sample / 100);
      assert.ok(whiteContrast(channels) >= 4.5, `segment ${segment}, sample ${sample}`);
    }
  }
});
test('brand colors, logo, aura, bar, recording dot and caret keep original gradients', () => {
  for (const [name, hex] of Object.entries({ blue: '#0a84ff', cyan: '#5ac8fa', violet: '#bf5af2', pink: '#ff375f', orange: '#ff9f0a' })) {
    assert.equal(cssValue(`--color-ai-${name}`), hex);
  }
  const compact = (value) => value.replace(/\s+/g, '');
  assert.equal(compact(cssValue('--ai-grad')), 'linear-gradient(90deg,var(--color-ai-blue)0%,var(--color-ai-violet)38%,var(--color-ai-pink)68%,var(--color-ai-orange)100%)');
  assert.equal(compact(cssValue('--ai-conic')), 'conic-gradient(fromvar(--mc-aura-angle),var(--color-ai-blue),var(--color-ai-violet),var(--color-ai-pink),var(--color-ai-orange),var(--color-ai-cyan),var(--color-ai-blue))');
  for (const selector of ['.ai-text', '.ai-bar']) assert.equal(background(selector), 'var(--ai-grad)');
  for (const selector of ['.ai-dot', '.ai-caret::after']) {
    assert.equal(compact(resolveColors(background(selector))), 'linear-gradient(135deg,#0a84ff,#bf5af255%,#ff375f)');
  }
});
test('settings tabs keep names and semantics without frequency annotations', () => {
  const tabs = settings.slice(settings.indexOf('const TABS:'), settings.indexOf('];', settings.indexOf('const TABS:')));
  assert.doesNotMatch(tabs, /一次|很少/);
  assert.doesNotMatch(settings, /\bfreq\b/);
  assert.match(tabs, /label: "帳號"/);
  assert.match(tabs, /label: "進階"/);
  assert.match(settings, /role="tablist"/);
  assert.match(settings, /role="tab"/);
  assert.match(settings, /aria-selected=\{selected\}/);
});

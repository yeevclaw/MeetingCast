import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const readRepoFile = (path) => readFile(new URL(`../../${path}`, import.meta.url), "utf8");
const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

test("release versions are x.y.z and match tauri.conf.json", async () => {
  const [packageJson, tauriJson, cargoToml, cargoLock] = await Promise.all([
    readRepoFile("package.json"),
    readRepoFile("src-tauri/tauri.conf.json"),
    readRepoFile("src-tauri/Cargo.toml"),
    readRepoFile("src-tauri/Cargo.lock"),
  ]);
  const packageSection = cargoToml
    .match(/^\[package\][ \t]*\r?\n([\s\S]*?)(?=^\s*\[|(?![\s\S]))/m)?.[1];
  const lockPackage = cargoLock.split(/^\[\[package\]\][ \t]*\r?$/m)
    .slice(1).find((entry) => /^name\s*=\s*"meetingcast"[ \t]*\r?$/m.test(entry));
  const readVersion = (section) => section?.match(/^version\s*=\s*"([^"]*)"[ \t]*(?:#.*)?\r?$/m)?.[1];
  const versions = {
    "package.json": JSON.parse(packageJson).version,
    "src-tauri/tauri.conf.json": JSON.parse(tauriJson).version,
    "src-tauri/Cargo.toml": readVersion(packageSection),
    "src-tauri/Cargo.lock (meetingcast)": readVersion(lockPackage),
  };
  const details = Object.entries(versions)
    .map(([path, version]) => `${path}: ${JSON.stringify(version)}`).join("\n");
  const expected = versions["src-tauri/tauri.conf.json"];
  for (const version of Object.values(versions)) {
    assert.ok(typeof version === "string" && semver.test(version), `Versions must use x.y.z:\n${details}`);
    assert.equal(version, expected, `Versions must match tauri.conf.json:\n${details}`);
  }
});

test("project instructions do not hardcode the current release version", async () => {
  const { version } = JSON.parse(await readRepoFile("src-tauri/tauri.conf.json"));
  assert.ok(typeof version === "string" && semver.test(version));
  const escapedVersion = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const currentVersion = new RegExp(`(?<![\\w.])v?${escapedVersion}(?![\\w.]|-[0-9A-Za-z]|\\+[0-9A-Za-z])`);
  for (const path of ["CLAUDE.md", "AGENTS.md"]) {
    const source = await readRepoFile(path);
    assert.doesNotMatch(source, /目前\s*ship\s+v?\d+\.\d+\.\d+/, `${path} must not hardcode 目前 ship X.Y.Z`);
    assert.doesNotMatch(source, currentVersion, `${path} must not hardcode current version ${version}`);
  }
});

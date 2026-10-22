import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { ESLint } from "eslint";

const eslint = new ESLint();

test("frontend checks have standalone scripts", async () => {
  const { scripts } = JSON.parse(
    await readFile(new URL("../../package.json", import.meta.url), "utf8"),
  );
  assert.equal(scripts.typecheck, "tsc --noEmit");
  assert.equal(scripts.lint, "eslint src");
});

test("lint accepts TypeScript and checks unused variables", async () => {
  const [valid] = await eslint.lintText("export const count: number = 1;", {
    filePath: "src/tooling-fixture.ts",
  });
  assert.equal(valid.errorCount, 0);
  const [invalid] = await eslint.lintText("const unused: number = 1;", {
    filePath: "src/tooling-fixture.ts",
  });
  assert.ok(invalid.messages.some((m) => m.ruleId === "@typescript-eslint/no-unused-vars" && m.severity === 2));
});

test("lint enforces hook ordering and warns about missing dependencies", async () => {
  const [result] = await eslint.lintText(`
    import { useEffect } from "react";
    export function Example({ active, value }: { active: boolean; value: string }) {
      if (active) {
        useEffect(() => { document.title = value; }, []);
      }
      return <div>{value}</div>;
    }
  `, { filePath: "src/tooling-fixture.tsx" });
  assert.ok(result.messages.some((m) => m.ruleId === "react-hooks/rules-of-hooks" && m.severity === 2));
  assert.ok(result.messages.some((m) => m.ruleId === "react-hooks/exhaustive-deps" && m.severity === 1));
});

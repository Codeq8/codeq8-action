import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("CLI source stays TypeScript and runtime JS stays generated", () => {
  const srcEntries = readdirSync(path.join(packageDir, "src"));
  assert.ok(srcEntries.some((entry) => entry.endsWith(".ts")));
  assert.deepEqual(
    srcEntries.filter((entry) => entry.endsWith(".mjs") || entry.endsWith(".js")),
    [],
  );

  const binSource = readFileSync(path.join(packageDir, "bin", "codeq8.js"), "utf8");
  assert.match(binSource, /from "\.\.\/dist\/cli\.js"/);
  assert.doesNotMatch(binSource, /from "\.\.\/src\//);
});

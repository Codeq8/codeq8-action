import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const repoRoot = path.resolve(import.meta.dirname, "..");

function leadingSpaces(line) {
  return line.match(/^ */)?.[0].length || 0;
}

test("composite action run blocks keep shell script inside YAML block indentation", () => {
  const manifest = fs.readFileSync(path.join(repoRoot, "action.yml"), "utf8");
  const lines = manifest.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!/^\s+run:\s*\|/.test(line)) {
      continue;
    }

    const runIndent = leadingSpaces(line);
    const scriptIndent = runIndent + 2;
    for (let scriptIndex = index + 1; scriptIndex < lines.length; scriptIndex += 1) {
      const scriptLine = lines[scriptIndex];
      if (!scriptLine.trim()) {
        continue;
      }
      const currentIndent = leadingSpaces(scriptLine);
      if (currentIndent <= runIndent) {
        break;
      }
      assert.ok(
        currentIndent >= scriptIndent,
        `action.yml:${scriptIndex + 1} escapes its run: | block indentation`,
      );
    }
  }
});

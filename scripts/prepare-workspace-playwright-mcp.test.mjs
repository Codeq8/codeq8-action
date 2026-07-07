import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { extractWorkspaceMcpSections } from "./sync-workspace-mcp-config.mjs";
import {
  collectWorkspacePlaywrightMcpInvocations,
  prepareWorkspacePlaywrightMcpBrowsers,
} from "./prepare-workspace-playwright-mcp.mjs";

const DRY_RUN_OUTPUT = `
Chrome for Testing 150.0.7871.24 (playwright chromium v1229)
  Install location:    /tmp/codeq8-ms-playwright/chromium-1229
  Download url:        https://cdn.playwright.dev/builds/cft/chrome.zip

FFmpeg (playwright ffmpeg v1011)
  Install location:    /tmp/codeq8-ms-playwright/ffmpeg-1011
  Download url:        https://cdn.playwright.dev/builds/ffmpeg.zip

Chrome Headless Shell 150.0.7871.24 (playwright chromium-headless-shell v1229)
  Install location:    /tmp/codeq8-ms-playwright/chromium_headless_shell-1229
  Download url:        https://cdn.playwright.dev/builds/cft/chrome-headless-shell.zip
`;

async function writeWorkspaceConfig(workspacePath, contents) {
  const configPath = path.join(workspacePath, ".codex", "config.toml");
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, contents, "utf8");
  return configPath;
}

async function writeCompletePayload(tempRoot) {
  const browserPath = path.join(tempRoot, "chromium-1229");
  const ffmpegPath = path.join(tempRoot, "ffmpeg-1011");
  const headlessShellPath = path.join(tempRoot, "chromium_headless_shell-1229");
  await fs.mkdir(
    path.join(
      browserPath,
      "chrome-mac-arm64",
      "Google Chrome for Testing.app",
      "Contents",
      "MacOS",
    ),
    { recursive: true },
  );
  await fs.mkdir(path.join(headlessShellPath, "chrome-headless-shell-mac-arm64"), {
    recursive: true,
  });
  await fs.mkdir(ffmpegPath, { recursive: true });
  await fs.writeFile(
    path.join(
      browserPath,
      "chrome-mac-arm64",
      "Google Chrome for Testing.app",
      "Contents",
      "MacOS",
      "Google Chrome for Testing",
    ),
    "",
    "utf8",
  );
  await fs.writeFile(
    path.join(headlessShellPath, "chrome-headless-shell-mac-arm64", "chrome-headless-shell"),
    "",
    "utf8",
  );
  for (const installPath of [browserPath, ffmpegPath, headlessShellPath]) {
    await fs.writeFile(path.join(installPath, "INSTALLATION_COMPLETE"), "", "utf8");
  }
}

async function withWorkspaceFixture(fn) {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codeq8-workspace-playwright-"));
  try {
    const workspacePath = path.join(tempRoot, "workspace");
    const browserCache = path.join(tempRoot, "ms-playwright");
    await fs.mkdir(workspacePath, { recursive: true });
    await fn({
      tempRoot,
      workspacePath,
      browserCache,
      dryRunOutput: DRY_RUN_OUTPUT.replaceAll("/tmp/codeq8-ms-playwright", browserCache),
    });
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

test("collectWorkspacePlaywrightMcpInvocations detects pnpm dlx @playwright/mcp@latest", () => {
  const sections = extractWorkspaceMcpSections([
    "[mcp_servers.playwright]",
    'command = "pnpm"',
    'args = ["dlx", "@playwright/mcp@latest", "--browser=chromium", "--headless"]',
    "",
    "[mcp_servers.context7]",
    'command = "npx"',
    'args = ["-y", "@upstash/context7-mcp"]',
    "",
  ].join("\n"));

  assert.deepEqual(collectWorkspacePlaywrightMcpInvocations(sections), [
    {
      serverId: "playwright",
      command: "pnpm",
      prefixArgs: ["dlx", "@playwright/mcp@latest"],
      browser: "chromium",
    },
  ]);
});

test("prepareWorkspacePlaywrightMcpBrowsers installs the browser revision required by workspace @playwright/mcp", async () => {
  await withWorkspaceFixture(async ({ workspacePath, browserCache, dryRunOutput }) => {
    await writeWorkspaceConfig(workspacePath, [
      "[mcp_servers.playwright]",
      'command = "pnpm"',
      'args = ["dlx", "@playwright/mcp@latest", "--browser=chromium", "--headless"]',
      "",
    ].join("\n"));
    const calls = [];
    const result = await prepareWorkspacePlaywrightMcpBrowsers({
      workspacePath,
      env: {
        ...process.env,
        PLAYWRIGHT_BROWSERS_PATH: browserCache,
      },
      runCommandImpl: async (command, args, options) => {
        calls.push({ command, args, cwd: options.cwd, browserCache: options.env.PLAYWRIGHT_BROWSERS_PATH });
        if (args.includes("--no-progress")) {
          await writeCompletePayload(browserCache);
        }
        return {
          ok: true,
          code: 0,
          stdout: dryRunOutput,
          stderr: "",
        };
      },
    });

    assert.equal(result.ok, true);
    assert.equal(result.status, "prepared");
    assert.deepEqual(
      calls.map((call) => call.args),
      [
        ["dlx", "@playwright/mcp@latest", "install-browser", "chromium", "--dry-run"],
        ["dlx", "@playwright/mcp@latest", "install-browser", "chromium", "--no-progress"],
        ["dlx", "@playwright/mcp@latest", "install-browser", "chromium", "--dry-run"],
      ],
    );
    assert.equal(calls.every((call) => call.cwd === workspacePath), true);
    assert.equal(calls.every((call) => call.browserCache === browserCache), true);
  });
});

test("prepareWorkspacePlaywrightMcpBrowsers does not trust top-level browser directories without payload sentinels", async () => {
  await withWorkspaceFixture(async ({ workspacePath, browserCache, dryRunOutput }) => {
    await writeWorkspaceConfig(workspacePath, [
      "[mcp_servers.playwright]",
      'command = "pnpm"',
      'args = ["dlx", "@playwright/mcp@latest", "--browser=chromium", "--headless"]',
      "",
    ].join("\n"));
    await fs.mkdir(path.join(browserCache, "chromium-1229"), { recursive: true });
    await fs.mkdir(path.join(browserCache, "ffmpeg-1011"), { recursive: true });
    await fs.mkdir(path.join(browserCache, "chromium_headless_shell-1229"), { recursive: true });
    const calls = [];
    await prepareWorkspacePlaywrightMcpBrowsers({
      workspacePath,
      env: {
        ...process.env,
        PLAYWRIGHT_BROWSERS_PATH: browserCache,
      },
      runCommandImpl: async (command, args) => {
        calls.push({ command, args });
        if (args.includes("--no-progress")) {
          await writeCompletePayload(browserCache);
        }
        return {
          ok: true,
          code: 0,
          stdout: dryRunOutput,
          stderr: "",
        };
      },
    });

    assert.deepEqual(
      calls.map((call) => call.args),
      [
        ["dlx", "@playwright/mcp@latest", "install-browser", "chromium", "--dry-run"],
        ["dlx", "@playwright/mcp@latest", "install-browser", "chromium", "--no-progress"],
        ["dlx", "@playwright/mcp@latest", "install-browser", "chromium", "--dry-run"],
      ],
    );
  });
});

test("prepareWorkspacePlaywrightMcpBrowsers skips install when workspace payload is complete", async () => {
  await withWorkspaceFixture(async ({ workspacePath, browserCache, dryRunOutput }) => {
    await writeWorkspaceConfig(workspacePath, [
      "[mcp_servers.playwright]",
      'command = "pnpm"',
      'args = ["dlx", "@playwright/mcp@latest", "--browser=chromium", "--headless"]',
      "",
    ].join("\n"));
    await writeCompletePayload(browserCache);
    const calls = [];
    const result = await prepareWorkspacePlaywrightMcpBrowsers({
      workspacePath,
      env: {
        ...process.env,
        PLAYWRIGHT_BROWSERS_PATH: browserCache,
      },
      runCommandImpl: async (command, args) => {
        calls.push({ command, args });
        return {
          ok: true,
          code: 0,
          stdout: dryRunOutput,
          stderr: "",
        };
      },
    });

    assert.equal(result.preparedServers[0].status, "already-prepared");
    assert.deepEqual(calls.map((call) => call.args), [
      ["dlx", "@playwright/mcp@latest", "install-browser", "chromium", "--dry-run"],
    ]);
  });
});

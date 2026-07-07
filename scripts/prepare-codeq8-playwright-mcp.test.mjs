import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  CODEQ8_PLAYWRIGHT_MCP_BROWSER,
  CODEQ8_PLAYWRIGHT_MCP_CAPABILITY,
  CODEQ8_PLAYWRIGHT_MCP_PACKAGE_NAME,
  CODEQ8_PLAYWRIGHT_MCP_PACKAGE_VERSION,
  CHROME_FOR_TESTING_BINARY_NAME,
  DEFAULT_CHROME_FOR_TESTING_BIN_PATH,
  DEFAULT_BROWSER_CACHE_LABEL,
  DEFAULT_BROWSER_CACHE_MARKER_FILE,
  buildPlaywrightMcpBrowserDryRunCommand,
  buildPlaywrightMcpBrowserInstallCommand,
  exposeChromeForTestingExecutable,
  findChromeForTestingExecutable,
  parsePlaywrightInstallLocations,
  prepareCodeq8PlaywrightMcp,
} from "./prepare-codeq8-playwright-mcp.mjs";

const DRY_RUN_OUTPUT = `
Chrome for Testing 149.0.7827.22 (playwright chromium v1226)
  Install location:    /tmp/codeq8-ms-playwright/chromium-1226
  Download url:        https://cdn.playwright.dev/builds/cft/chrome.zip

FFmpeg (playwright ffmpeg v1011)
  Install location:    /tmp/codeq8-ms-playwright/ffmpeg-1011
  Download url:        https://cdn.playwright.dev/builds/ffmpeg.zip
`;

async function withTempPlaywrightPayload(fn) {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codeq8-playwright-mcp-"));
  try {
    const browserPath = path.join(tempRoot, "chromium-1226");
    const ffmpegPath = path.join(tempRoot, "ffmpeg-1011");
    const chromeExecutablePath = path.join(browserPath, "chrome-linux", "chrome");
    const fakeMcpPath = path.join(tempRoot, "playwright-mcp");
    await fs.mkdir(path.dirname(chromeExecutablePath), { recursive: true });
    await fs.mkdir(ffmpegPath, { recursive: true });
    await fs.writeFile(chromeExecutablePath, "#!/bin/sh\nexit 0\n", "utf8");
    await fs.chmod(chromeExecutablePath, 0o755);
    await fs.writeFile(fakeMcpPath, "#!/bin/sh\nexit 0\n", "utf8");
    await fs.chmod(fakeMcpPath, 0o755);
    await fn({
      tempRoot,
      markerFile: path.join(tempRoot, "marker.json"),
      browserPath,
      ffmpegPath,
      chromeExecutablePath,
      fakeMcpPath,
      dryRunOutput: DRY_RUN_OUTPUT.replaceAll("/tmp/codeq8-ms-playwright", tempRoot),
    });
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

test("buildPlaywrightMcpBrowserInstallCommand uses the pinned global MCP binary", () => {
  const command = buildPlaywrightMcpBrowserInstallCommand({
    playwrightMcpPath: "/Users/example/.npm-global/bin/playwright-mcp",
    browser: CODEQ8_PLAYWRIGHT_MCP_BROWSER,
  });

  assert.equal(command.command, "/Users/example/.npm-global/bin/playwright-mcp");
  assert.deepEqual(command.args, ["install-browser", "chromium", "--no-progress"]);
});

test("findChromeForTestingExecutable locates the installed Chromium executable", async () => {
  await withTempPlaywrightPayload(async ({ browserPath, chromeExecutablePath }) => {
    assert.equal(
      await findChromeForTestingExecutable([browserPath]),
      chromeExecutablePath,
    );
  });
});

test("exposeChromeForTestingExecutable writes stable chrome-for-testing wrapper", async () => {
  await withTempPlaywrightPayload(async ({ tempRoot, browserPath, chromeExecutablePath }) => {
    const browserBinPath = path.join(tempRoot, "browser-bin");
    const result = await exposeChromeForTestingExecutable({
      installLocations: [browserPath],
      env: {
        HOME: tempRoot,
        CODEQ8_CHROME_FOR_TESTING_BIN_PATH: browserBinPath,
      },
    });

    assert.equal(result.ok, true);
    assert.equal(result.executablePath, chromeExecutablePath);
    assert.equal(result.wrapperPath, path.join(browserBinPath, CHROME_FOR_TESTING_BINARY_NAME));
    const wrapper = await fs.readFile(result.wrapperPath, "utf8");
    assert.match(wrapper, /exec ".+chrome" "\$@"/);
  });
});

test("buildPlaywrightMcpBrowserDryRunCommand inspects browser payload paths without installing", () => {
  const command = buildPlaywrightMcpBrowserDryRunCommand({
    playwrightMcpPath: "playwright-mcp",
    browser: CODEQ8_PLAYWRIGHT_MCP_BROWSER,
  });

  assert.equal(command.command, "playwright-mcp");
  assert.deepEqual(command.args, ["install-browser", "chromium", "--dry-run"]);
});

test("parsePlaywrightInstallLocations extracts dry-run payload paths", () => {
  assert.deepEqual(parsePlaywrightInstallLocations(DRY_RUN_OUTPUT), [
    "/tmp/codeq8-ms-playwright/chromium-1226",
    "/tmp/codeq8-ms-playwright/ffmpeg-1011",
  ]);
});

test("Playwright MCP package manifest matches prep script pin", async () => {
  const manifest = JSON.parse(
    await fs.readFile(path.join(process.cwd(), "playwright-mcp", "package.json"), "utf8"),
  );

  assert.equal(manifest.name, CODEQ8_PLAYWRIGHT_MCP_PACKAGE_NAME);
  assert.equal(manifest.version, CODEQ8_PLAYWRIGHT_MCP_PACKAGE_VERSION);
});

test("prepareCodeq8PlaywrightMcp skips install when marker and payload paths match", async () => {
  await withTempPlaywrightPayload(async ({ markerFile, dryRunOutput, browserPath, ffmpegPath, fakeMcpPath }) => {
    await fs.writeFile(
      markerFile,
      `${JSON.stringify(
        {
          managed_by: "codeq8-playwright-mcp-prep",
          capability: CODEQ8_PLAYWRIGHT_MCP_CAPABILITY,
          package_name: CODEQ8_PLAYWRIGHT_MCP_PACKAGE_NAME,
          package_version: CODEQ8_PLAYWRIGHT_MCP_PACKAGE_VERSION,
          browser: CODEQ8_PLAYWRIGHT_MCP_BROWSER,
          playwright_browsers_path: "/tmp/codeq8-browsers",
          install_locations: [browserPath, ffmpegPath],
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const calls = [];
    const logs = [];
    const result = await prepareCodeq8PlaywrightMcp({
      repoRoot: process.cwd(),
      markerFile,
      playwrightMcpPath: fakeMcpPath,
      env: {
        HOME: path.dirname(markerFile),
        PLAYWRIGHT_BROWSERS_PATH: "/tmp/codeq8-browsers",
      },
      runCommandImpl: async (call) => {
        calls.push(call);
        return { ok: true, code: 0, stdout: dryRunOutput, stderr: "" };
      },
      logger: {
        log: (message) => logs.push(message),
      },
    });

    assert.equal(result.ok, true);
    assert.equal(result.status, "already-prepared");
    assert.equal(result.chromeForTesting.ok, true);
    assert.equal(
      result.chromeForTesting.wrapperPath,
      path.join(
        path.dirname(markerFile),
        DEFAULT_CHROME_FOR_TESTING_BIN_PATH.replace("~/", ""),
        CHROME_FOR_TESTING_BINARY_NAME,
      ),
    );
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].args, ["install-browser", "chromium", "--dry-run"]);
    assert.match(logs.join("\n"), /status=already-prepared/);
  });
});

test("prepareCodeq8PlaywrightMcp installs and writes marker when marker is missing", async () => {
  await withTempPlaywrightPayload(async ({
    markerFile,
    dryRunOutput,
    browserPath,
    ffmpegPath,
    chromeExecutablePath,
    fakeMcpPath,
  }) => {
    const calls = [];
    const logs = [];
    const result = await prepareCodeq8PlaywrightMcp({
      repoRoot: process.cwd(),
      markerFile,
      playwrightMcpPath: fakeMcpPath,
      env: {
        HOME: path.dirname(markerFile),
        PLAYWRIGHT_BROWSERS_PATH: "/tmp/codeq8-browsers",
      },
      runCommandImpl: async (call) => {
        calls.push(call);
        return { ok: true, code: 0, stdout: dryRunOutput, stderr: "" };
      },
      logger: {
        log: (message) => logs.push(message),
      },
    });

    assert.equal(result.ok, true);
    assert.equal(result.status, "prepared");
    assert.equal(result.capability, CODEQ8_PLAYWRIGHT_MCP_CAPABILITY);
    assert.equal(result.chromeForTesting.ok, true);
    assert.deepEqual(
      calls.map((call) => call.args),
      [
        ["install-browser", "chromium", "--dry-run"],
        ["install-browser", "chromium", "--no-progress"],
        ["install-browser", "chromium", "--dry-run"],
      ],
    );
    const marker = JSON.parse(await fs.readFile(markerFile, "utf8"));
    assert.equal(marker.package_name, CODEQ8_PLAYWRIGHT_MCP_PACKAGE_NAME);
    assert.equal(marker.package_version, CODEQ8_PLAYWRIGHT_MCP_PACKAGE_VERSION);
    assert.equal(marker.playwright_browsers_path, "/tmp/codeq8-browsers");
    assert.deepEqual(marker.install_locations, [browserPath, ffmpegPath]);
    assert.equal(marker.chrome_for_testing_executable, chromeExecutablePath);
    assert.equal(marker.chrome_for_testing_wrapper, result.chromeForTesting.wrapperPath);
    assert.match(logs.join("\n"), /status=prepared/);
  });
});

test("prepareCodeq8PlaywrightMcp can prepare the platform default browser cache", async () => {
  await withTempPlaywrightPayload(async ({ markerFile, dryRunOutput, browserPath, ffmpegPath, fakeMcpPath }) => {
    const calls = [];
    const result = await prepareCodeq8PlaywrightMcp({
      repoRoot: process.cwd(),
      markerFile,
      playwrightMcpPath: fakeMcpPath,
      defaultBrowserCache: true,
      env: {
        HOME: path.dirname(markerFile),
        PLAYWRIGHT_BROWSERS_PATH: "/tmp/codeq8-browsers",
      },
      runCommandImpl: async (call) => {
        calls.push(call);
        return { ok: true, code: 0, stdout: dryRunOutput, stderr: "" };
      },
    });

    assert.equal(result.ok, true);
    assert.equal(result.browserCache, DEFAULT_BROWSER_CACHE_LABEL);
    assert.deepEqual(
      calls.map((call) => call.env.PLAYWRIGHT_BROWSERS_PATH),
      [undefined, undefined, undefined],
    );
    const marker = JSON.parse(await fs.readFile(markerFile, "utf8"));
    assert.equal(marker.playwright_browsers_path, DEFAULT_BROWSER_CACHE_LABEL);
    assert.deepEqual(marker.install_locations, [browserPath, ffmpegPath]);
  });
});

test("prepareCodeq8PlaywrightMcp throws when required browser install fails", async () => {
  await withTempPlaywrightPayload(async ({ markerFile, dryRunOutput, fakeMcpPath }) => {
    await assert.rejects(
      prepareCodeq8PlaywrightMcp({
        repoRoot: process.cwd(),
        markerFile,
        playwrightMcpPath: fakeMcpPath,
        env: {
          HOME: path.dirname(markerFile),
        },
        runCommandImpl: async (call) => {
          if (call.args.includes("--no-progress")) {
            return {
              ok: false,
              code: 1,
              stdout: "",
              stderr: "browser CDN unavailable\nmore details",
            };
          }
          return { ok: true, code: 0, stdout: dryRunOutput, stderr: "" };
        },
      }),
      /Unable to install required Playwright MCP browser payload.*browser CDN unavailable/,
    );
  });
});

test("public action prepares global tools before Playwright MCP browser payload", async () => {
  const actionSource = await fs.readFile(path.join(process.cwd(), "action.yml"), "utf8");
  const pluginInstallIndex = actionSource.indexOf("scripts/install-codeq8-plugin.mjs");
  const globalToolsIndex = actionSource.indexOf("scripts/runner-global-cli-tools.mjs");
  const playwrightPrepIndex = actionSource.indexOf("scripts/prepare-codeq8-playwright-mcp.mjs");
  const defaultBrowserCacheIndex = actionSource.indexOf("--default-browser-cache");
  const workspaceMcpSyncIndex = actionSource.indexOf("scripts/sync-workspace-mcp-config.mjs");
  const workspacePlaywrightPrepIndex = actionSource.indexOf(
    "scripts/prepare-workspace-playwright-mcp.mjs",
  );

  assert.notEqual(pluginInstallIndex, -1);
  assert.notEqual(globalToolsIndex, -1);
  assert.notEqual(playwrightPrepIndex, -1);
  assert.notEqual(defaultBrowserCacheIndex, -1);
  assert.notEqual(workspaceMcpSyncIndex, -1);
  assert.notEqual(workspacePlaywrightPrepIndex, -1);
  assert.equal(pluginInstallIndex < globalToolsIndex, true);
  assert.equal(globalToolsIndex < playwrightPrepIndex, true);
  assert.equal(playwrightPrepIndex < defaultBrowserCacheIndex, true);
  assert.equal(workspaceMcpSyncIndex < workspacePlaywrightPrepIndex, true);
  assert.match(actionSource, /machine_path="\$\{PATH\}"/);
  assert.match(actionSource, /CODEQ8_MACHINE_PATH=\$\{machine_path\}/);
  assert.match(actionSource, /chrome_for_testing_bin_path="\$\{HOME\}\/\.cache\/codeq8\/chrome-for-testing-bin"/);
  assert.match(actionSource, /CODEQ8_CHROME_FOR_TESTING_BIN_PATH=\$\{chrome_for_testing_bin_path\}/);
  assert.match(actionSource, /echo "\$\{chrome_for_testing_bin_path\}" >> "\$GITHUB_PATH"/);
  assert.match(actionSource, /NPM_CONFIG_PREFIX=\$\{npm_global_prefix\}/);
  assert.match(actionSource, /PLAYWRIGHT_BROWSERS_PATH=\$\{playwright_browsers_path\}/);
  assert.match(
    actionSource,
    new RegExp(DEFAULT_BROWSER_CACHE_MARKER_FILE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
  );
});

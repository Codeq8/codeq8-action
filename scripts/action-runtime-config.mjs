#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

export const ACTION_RUNTIME_CONFIG_FILENAME = "action-runtime.json";

function normalizeText(value) {
  return String(value || "").trim();
}

function normalizeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function normalizeNodeMajor(value) {
  const match = normalizeText(value).match(/^v?(\d{1,3})/);
  return match ? match[1] : "";
}

export function resolveActionRuntimeConfigPath(actionRoot = process.cwd()) {
  return path.join(path.resolve(actionRoot), ACTION_RUNTIME_CONFIG_FILENAME);
}

export async function readActionRuntimeConfig({ actionRoot = process.cwd() } = {}) {
  const configPath = resolveActionRuntimeConfigPath(actionRoot);
  let raw = "";
  try {
    raw = await fs.readFile(configPath, "utf8");
  } catch {
    return {};
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }

  const normalized = normalizeObject(parsed);
  if (Object.keys(normalized).length === 0 || normalizeText(normalized.version) !== "1") {
    return {};
  }
  return normalized;
}

export async function readRequiredActionNodeMajor({ actionRoot = process.cwd() } = {}) {
  const config = await readActionRuntimeConfig({ actionRoot });
  return normalizeNodeMajor(config.node_major || config.nodeMajor || "");
}

export async function readDesiredActionCliToolVersions({ actionRoot = process.cwd() } = {}) {
  const config = await readActionRuntimeConfig({ actionRoot });
  const cliTools =
    config && typeof config.cli_tools === "object" && !Array.isArray(config.cli_tools)
      ? config.cli_tools
      : {};
  return normalizeObject(cliTools);
}

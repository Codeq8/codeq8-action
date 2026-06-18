import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type { AuthState, AuthWriteOptions } from "./cli-types.js";

const KEYCHAIN_SERVICE = "codeq8-cli";

type AuthStorageOptions = {
  baseUrl?: string;
};

type AuthStoragePayload = {
  token?: unknown;
  tokenType?: unknown;
  createdAt?: unknown;
  baseUrl?: unknown;
};

function normalize(value: unknown): string {
  return String(value ?? "").trim();
}

function normalizeBaseUrl(baseUrl?: string): string {
  const raw = normalize(baseUrl || process.env.CODEQ8_BASE_URL || "https://codeq8.com");
  const withProtocol = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  let parsed;
  try {
    parsed = new URL(withProtocol);
  } catch {
    parsed = new URL("https://codeq8.com");
  }
  parsed.pathname = "";
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/+$/, "");
}

function resolveProfileId(baseUrl?: string): string {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  const parsed = new URL(normalizedBaseUrl);
  const normalizedHost = normalize(parsed.host).toLowerCase().replace(/[^a-z0-9._-]/g, "_");
  return normalizedHost || "default";
}

function resolveConfigRoot(): string {
  const explicit = normalize(process.env.CODEQ8_CONFIG_HOME);
  if (explicit) {
    return explicit;
  }

  const xdg = normalize(process.env.XDG_CONFIG_HOME);
  if (xdg) {
    return path.join(xdg, "codeq8");
  }

  const home = normalize(os.homedir());
  if (!home) {
    throw new Error("Unable to resolve a home directory for Codeq8 config.");
  }

  return path.join(home, ".config", "codeq8");
}

async function setOwnerOnlyPermissions(targetPath: string, mode: number): Promise<void> {
  try {
    await chmod(targetPath, mode);
  } catch (error) {
    if (process.platform === "win32") {
      return;
    }
    throw error;
  }
}

function resolveStorageMode(): "auto" | "file" | "keychain" {
  const requested = normalize(process.env.CODEQ8_AUTH_STORAGE).toLowerCase();
  if (requested === "file" || requested === "keychain") {
    return requested;
  }
  return "auto";
}

function hasMacosKeychainSupport(): boolean {
  if (process.platform !== "darwin") {
    return false;
  }
  const probe = spawnSync("security", ["-h"], { encoding: "utf8" });
  return !probe.error;
}

function shouldUseKeychain(): boolean {
  const mode = resolveStorageMode();
  if (mode === "file") {
    return false;
  }
  if (mode === "keychain") {
    return true;
  }
  return hasMacosKeychainSupport();
}

function resolveKeychainAccount(baseUrl?: string): string {
  return `codeq8@${resolveProfileId(baseUrl)}`;
}

function runCommand(command: string, args: readonly string[]) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (result.error) {
    throw result.error;
  }

  return {
    status: Number(result.status ?? 1),
    stdout: normalize(result.stdout),
    stderr: normalize(result.stderr),
  };
}

function isKeychainMissingEntry(errorText: unknown): boolean {
  const normalized = normalize(errorText).toLowerCase();
  return normalized.includes("could not be found") || normalized.includes("item not found");
}

function readAuthStateFromKeychain({ baseUrl }: AuthStorageOptions): AuthState | null {
  const account = resolveKeychainAccount(baseUrl);
  const result = runCommand("security", [
    "find-generic-password",
    "-a",
    account,
    "-s",
    KEYCHAIN_SERVICE,
    "-w",
  ]);
  if (result.status !== 0) {
    if (isKeychainMissingEntry(result.stderr)) {
      return null;
    }
    throw new Error(result.stderr || `Unable to read keychain secret (${result.status}).`);
  }

  let payload: AuthStoragePayload = {};
  try {
    payload = JSON.parse(result.stdout);
  } catch {
    payload = { token: result.stdout };
  }

  const token = normalize(payload.token);
  if (!token) {
    return null;
  }

  return {
    token,
    tokenType: normalize(payload.tokenType) || "bearer",
    createdAt: normalize(payload.createdAt),
    baseUrl: normalize(payload.baseUrl) || normalizeBaseUrl(baseUrl),
    backend: "keychain",
  };
}

function writeAuthStateToKeychain({
  baseUrl,
  token,
  tokenType,
}: Required<Pick<AuthWriteOptions, "token">> & AuthWriteOptions): void {
  const account = resolveKeychainAccount(baseUrl);
  const serialized = JSON.stringify({
    token,
    tokenType: normalize(tokenType) || "bearer",
    createdAt: new Date().toISOString(),
    baseUrl: normalizeBaseUrl(baseUrl),
  });

  const result = runCommand("security", [
    "add-generic-password",
    "-U",
    "-a",
    account,
    "-s",
    KEYCHAIN_SERVICE,
    "-w",
    serialized,
  ]);
  if (result.status !== 0) {
    throw new Error(result.stderr || `Unable to write keychain secret (${result.status}).`);
  }
}

function clearAuthStateFromKeychain({ baseUrl }: AuthStorageOptions): void {
  const account = resolveKeychainAccount(baseUrl);
  const result = runCommand("security", [
    "delete-generic-password",
    "-a",
    account,
    "-s",
    KEYCHAIN_SERVICE,
  ]);
  if (result.status !== 0 && !isKeychainMissingEntry(result.stderr)) {
    throw new Error(result.stderr || `Unable to delete keychain secret (${result.status}).`);
  }
}

function resolveAuthFilePath(baseUrl?: string): string {
  const profileId = resolveProfileId(baseUrl);
  return path.join(resolveConfigRoot(), `auth-${profileId}.json`);
}

async function readAuthStateFromFile({ baseUrl }: AuthStorageOptions): Promise<AuthState | null> {
  const authPath = resolveAuthFilePath(baseUrl);
  try {
    const raw = await readFile(authPath, "utf8");
    const payload = JSON.parse(raw) as AuthStoragePayload;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return null;
    }

    const token = normalize(payload.token);
    if (!token) {
      return null;
    }

    return {
      token,
      tokenType: normalize(payload.tokenType) || "bearer",
      createdAt: normalize(payload.createdAt),
      baseUrl: normalize(payload.baseUrl) || normalizeBaseUrl(baseUrl),
      backend: "file",
    };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function writeAuthStateToFile({
  baseUrl,
  token,
  tokenType,
}: Required<Pick<AuthWriteOptions, "token">> & AuthWriteOptions): Promise<void> {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  const authPath = resolveAuthFilePath(baseUrl);
  const configRoot = path.dirname(authPath);
  await mkdir(configRoot, { recursive: true, mode: 0o700 });
  await setOwnerOnlyPermissions(configRoot, 0o700);

  const payload = {
    token,
    tokenType: normalize(tokenType) || "bearer",
    createdAt: new Date().toISOString(),
    baseUrl: normalizedBaseUrl,
  };

  await writeFile(authPath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  await setOwnerOnlyPermissions(authPath, 0o600);
}

async function clearAuthStateFromFile({ baseUrl }: AuthStorageOptions): Promise<void> {
  const authPath = resolveAuthFilePath(baseUrl);
  try {
    await rm(authPath, { force: true });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return;
    }
    throw error;
  }
}

export function resolveAuthStorageBackend(): "file" | "keychain" {
  return shouldUseKeychain() ? "keychain" : "file";
}

export function resolveNormalizedBaseUrl(baseUrl?: string): string {
  return normalizeBaseUrl(baseUrl);
}

export async function readAuthState({ baseUrl }: AuthStorageOptions = {}): Promise<AuthState | null> {
  if (shouldUseKeychain()) {
    try {
      return readAuthStateFromKeychain({ baseUrl });
    } catch (error) {
      if (resolveStorageMode() === "keychain") {
        throw error;
      }
    }
  }

  return await readAuthStateFromFile({ baseUrl });
}

export async function writeAuthState({
  token,
  tokenType = "bearer",
  baseUrl,
}: AuthWriteOptions = {}): Promise<void> {
  const normalizedToken = normalize(token);
  if (!normalizedToken) {
    throw new Error("Token is required.");
  }

  if (shouldUseKeychain()) {
    try {
      writeAuthStateToKeychain({ baseUrl, token: normalizedToken, tokenType });
      return;
    } catch (error) {
      if (resolveStorageMode() === "keychain") {
        throw error;
      }
    }
  }

  await writeAuthStateToFile({
    baseUrl,
    token: normalizedToken,
    tokenType,
  });
}

export async function clearAuthState({ baseUrl }: AuthStorageOptions = {}): Promise<void> {
  if (shouldUseKeychain()) {
    try {
      clearAuthStateFromKeychain({ baseUrl });
      return;
    } catch (error) {
      if (resolveStorageMode() === "keychain") {
        throw error;
      }
    }
  }

  await clearAuthStateFromFile({ baseUrl });
}

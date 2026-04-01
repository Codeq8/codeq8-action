import fs from "node:fs/promises";
import path from "node:path";

export const CODEX_AUTH_BUNDLE_FILES = ["auth.json", "config.toml", "version.json"];

function normalizeText(value) {
  return String(value || "").trim();
}

function normalizeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function decodeJwtClaims(token) {
  const normalizedToken = normalizeText(token);
  if (!normalizedToken) {
    return {};
  }
  const [, payload = ""] = normalizedToken.split(".", 3);
  if (!payload) {
    return {};
  }
  try {
    const normalizedPayload = payload.replace(/-/g, "+").replace(/_/g, "/");
    const paddingLength = normalizedPayload.length % 4;
    const paddedPayload =
      paddingLength === 0
        ? normalizedPayload
        : normalizedPayload + "=".repeat(4 - paddingLength);
    const decoded = Buffer.from(paddedPayload, "base64").toString("utf8");
    return normalizeObject(JSON.parse(decoded));
  } catch {
    return {};
  }
}

export async function readCodexAuthBundle(
  codexHome,
  bundleFiles = CODEX_AUTH_BUNDLE_FILES,
) {
  const files = {};
  for (const relativePath of Array.isArray(bundleFiles) ? bundleFiles : CODEX_AUTH_BUNDLE_FILES) {
    const absolutePath = path.join(codexHome, relativePath);
    try {
      const contents = await fs.readFile(absolutePath, "utf8");
      files[relativePath] = contents;
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        continue;
      }
      throw error;
    }
  }
  if (!files["auth.json"]) {
    throw new Error("Codex login completed without writing auth.json.");
  }

  let authPayload = {};
  try {
    authPayload = JSON.parse(files["auth.json"]);
  } catch (error) {
    throw new Error(
      `Unable to parse Codex auth.json: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const normalizedAuthPayload = normalizeObject(authPayload);
  const tokens = normalizeObject(normalizedAuthPayload.tokens);
  const authMode = normalizeText(normalizedAuthPayload.auth_mode || normalizedAuthPayload.authMode);
  const accountId = normalizeText(tokens.account_id || tokens.accountId);
  if (!authMode || !accountId) {
    throw new Error("Codex auth bundle is missing auth_mode or account_id.");
  }

  const idTokenClaims = decodeJwtClaims(tokens.id_token || tokens.idToken || "");
  const email = normalizeText(idTokenClaims.email || "", 255).toLowerCase();
  const displayName = normalizeText(
    idTokenClaims.name || idTokenClaims.email || accountId,
    255,
  );
  const subject = normalizeText(idTokenClaims.sub || "", 255);

  return {
    accountId,
    authMode,
    displayName,
    email,
    subject,
    files,
  };
}

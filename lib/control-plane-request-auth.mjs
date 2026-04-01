import { normalizeText } from "./code-worker-url.mjs";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const CONTROL_PLANE_REQUEST_TOKEN_TTL_SECONDS = 60;

export const MISSING_CONTROL_PLANE_REQUEST_AUTH_SECRET_ERROR =
  "CODE_GITHUB_SESSION_SECRET or GH_OAUTH_STATE_SECRET is missing.";

function toBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromBase64Url(value) {
  const normalized = normalizeText(value).replace(/-/g, "+").replace(/_/g, "/");
  const padding = normalized.length % 4;
  const padded = padding === 0 ? normalized : normalized + "=".repeat(4 - padding);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function payloadRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

async function importSigningKey(secret) {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

function timingSafeEqualBytes(left, right) {
  if (!(left instanceof Uint8Array) || !(right instanceof Uint8Array)) {
    return false;
  }
  if (left.byteLength !== right.byteLength) {
    return false;
  }
  let result = 0;
  for (let index = 0; index < left.byteLength; index += 1) {
    result |= left[index] ^ right[index];
  }
  return result === 0;
}

function normalizeControlPlaneRequestMethod(value) {
  const normalized = normalizeText(value).toUpperCase();
  return normalized === "POST" || normalized === "GET" ? normalized : "";
}

function normalizeControlPlaneRequestPath(value) {
  const normalized = normalizeText(value);
  if (!normalized) {
    return "";
  }

  try {
    if (/^https?:\/\//i.test(normalized)) {
      const parsed = new URL(normalized);
      return parsed.pathname || "/";
    }

    const parsed = new URL(normalized, "https://codeq8.local");
    return parsed.pathname || "/";
  } catch {
    if (!normalized.startsWith("/")) {
      return "";
    }
    return normalized.split("?")[0].split("#")[0] || "/";
  }
}

function normalizeControlPlaneRequestTokenPayload(payload) {
  const record = payloadRecord(payload);
  return {
    typ: normalizeText(record.typ),
    method: normalizeControlPlaneRequestMethod(record.method),
    path: normalizeControlPlaneRequestPath(record.path),
    iat: Math.floor(Number(record.iat || 0) || 0),
    exp: Math.floor(Number(record.exp || 0) || 0),
  };
}

export function resolveControlPlaneRequestAuthSecret(env = globalThis.process?.env || {}) {
  return normalizeText(env.CODE_GITHUB_SESSION_SECRET || env.GH_OAUTH_STATE_SECRET || "");
}

export async function createControlPlaneRequestToken(
  {
    method,
    path,
    issuedAt = Math.floor(Date.now() / 1000),
    expiresInSeconds = CONTROL_PLANE_REQUEST_TOKEN_TTL_SECONDS,
  },
  env = globalThis.process?.env || {},
) {
  const secret = resolveControlPlaneRequestAuthSecret(env);
  if (!secret) {
    throw new Error(MISSING_CONTROL_PLANE_REQUEST_AUTH_SECRET_ERROR);
  }

  const normalizedMethod = normalizeControlPlaneRequestMethod(method);
  const normalizedPath = normalizeControlPlaneRequestPath(path);
  const normalizedIssuedAt = Math.floor(Number(issuedAt || 0) || 0);
  const normalizedExpiresInSeconds = Math.max(
    15,
    Math.min(10 * 60, Math.floor(Number(expiresInSeconds || 0) || 0)),
  );
  if (!normalizedMethod || !normalizedPath || !normalizedIssuedAt) {
    throw new Error("method, path, and issuedAt are required.");
  }

  const payload = {
    typ: "control_plane_request",
    method: normalizedMethod,
    path: normalizedPath,
    iat: normalizedIssuedAt,
    exp: normalizedIssuedAt + normalizedExpiresInSeconds,
  };
  const header = toBase64Url(
    encoder.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })),
  );
  const body = toBase64Url(encoder.encode(JSON.stringify(payload)));
  const data = `${header}.${body}`;
  const key = await importSigningKey(secret);
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(data));
  return `${data}.${toBase64Url(new Uint8Array(signature))}`;
}

export async function buildControlPlaneRequestAuthorizationHeader(
  { method, path },
  env = globalThis.process?.env || {},
) {
  const token = await createControlPlaneRequestToken({ method, path }, env);
  return `Bearer ${token}`;
}

export async function verifyControlPlaneRequestAuthorization(
  {
    authorizationHeader = "",
    method,
    path,
  },
  env = globalThis.process?.env || {},
) {
  const secret = resolveControlPlaneRequestAuthSecret(env);
  if (!secret) {
    return {
      ok: false,
      error: MISSING_CONTROL_PLANE_REQUEST_AUTH_SECRET_ERROR,
    };
  }

  const matched = normalizeText(authorizationHeader).match(/^Bearer\s+(.+)$/i);
  const token = matched ? normalizeText(matched[1]) : "";
  if (!token) {
    return { ok: false, error: "Authorization token is missing." };
  }

  const parts = token.split(".");
  if (parts.length !== 3) {
    return { ok: false, error: "Authorization token shape is invalid." };
  }

  const [header, body, signature] = parts;
  const data = `${header}.${body}`;

  let actualSignature;
  try {
    actualSignature = fromBase64Url(signature);
  } catch {
    return { ok: false, error: "Authorization token signature is invalid." };
  }

  const key = await importSigningKey(secret);
  const expectedSignatureBuffer = await crypto.subtle.sign("HMAC", key, encoder.encode(data));
  const expectedSignature = new Uint8Array(expectedSignatureBuffer);
  if (!timingSafeEqualBytes(actualSignature, expectedSignature)) {
    return { ok: false, error: "Authorization token signature mismatch." };
  }

  let payload;
  try {
    payload = JSON.parse(decoder.decode(fromBase64Url(body)));
  } catch {
    return { ok: false, error: "Authorization token payload is invalid JSON." };
  }

  const normalizedPayload = normalizeControlPlaneRequestTokenPayload(payload);
  const expectedMethod = normalizeControlPlaneRequestMethod(method);
  const expectedPath = normalizeControlPlaneRequestPath(path);
  const now = Math.floor(Date.now() / 1000);
  if (normalizedPayload.typ !== "control_plane_request") {
    return { ok: false, error: "Authorization token type is invalid." };
  }
  if (!normalizedPayload.method || normalizedPayload.method !== expectedMethod) {
    return { ok: false, error: "Authorization token method mismatch." };
  }
  if (!normalizedPayload.path || normalizedPayload.path !== expectedPath) {
    return { ok: false, error: "Authorization token path mismatch." };
  }
  if (!normalizedPayload.exp || normalizedPayload.exp <= now) {
    return { ok: false, error: "Authorization token has expired." };
  }

  return { ok: true, payload: normalizedPayload };
}

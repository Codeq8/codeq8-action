export const DEFAULT_CODE_PUBLIC_BASE_URL = "https://codeq8.com";
export const DEFAULT_PUBLIC_OAUTH_START_URL =
  `${DEFAULT_CODE_PUBLIC_BASE_URL}/api/github/oauth/start`;
const DEFAULT_CODE_PUBLIC_BASE_HOSTNAME = "codeq8.com";

/** @param {unknown} value */
export function normalizeText(value) {
  return String(value ?? "").trim();
}

/** @param {unknown} value */
export function normalizeBaseUrl(value) {
  const normalized = normalizeText(value).replace(/\/+$/, "");
  if (!normalized) {
    return "";
  }
  if (/^https?:\/\//i.test(normalized)) {
    return normalized;
  }
  return `https://${normalized}`;
}

/** @param {unknown} value */
export function normalizeAbsoluteUrl(value) {
  const normalized = normalizeText(value);
  if (!normalized || !/^https?:\/\//i.test(normalized)) {
    return "";
  }
  try {
    return new URL(normalized).toString();
  } catch {
    return "";
  }
}

function readHeader(headers, name) {
  if (!headers) {
    return "";
  }
  if (typeof headers.get === "function") {
    return normalizeText(headers.get(name));
  }
  if (typeof headers === "object") {
    const directValue = headers[name] ?? headers[name.toLowerCase()];
    if (Array.isArray(directValue)) {
      return normalizeText(directValue[0]);
    }
    return normalizeText(directValue);
  }
  return "";
}

/**
 * @param {Request | { headers?: Headers | Record<string, string | string[] | undefined>; nextUrl?: { origin?: string; host?: string; protocol?: string }; url?: string } | null | undefined} request
 */
export function resolveRequestOrigin(request) {
  const forwardedProto = normalizeText(readHeader(request?.headers, "x-forwarded-proto"))
    .split(",")[0]
    .replace(/:$/, "")
    .trim();
  const forwardedHost = normalizeText(
    readHeader(request?.headers, "x-forwarded-host") ||
      readHeader(request?.headers, "host"),
  )
    .split(",")[0]
    .trim();
  const nextUrlProtocol = normalizeText(request?.nextUrl?.protocol).replace(/:$/, "");
  const nextUrlHost = normalizeText(request?.nextUrl?.host);
  const nextUrlOrigin = normalizeBaseUrl(request?.nextUrl?.origin || "");
  const requestUrlOrigin = normalizeAbsoluteUrl(request?.url || "");
  const requestUrlProtocol = requestUrlOrigin
    ? new URL(requestUrlOrigin).protocol.replace(/:$/, "")
    : "";
  const protocol = forwardedProto || nextUrlProtocol || requestUrlProtocol;
  const host = forwardedHost || nextUrlHost;

  if (host) {
    return normalizeBaseUrl(`${protocol || "https"}://${host}`);
  }
  if (nextUrlOrigin) {
    return nextUrlOrigin;
  }
  if (requestUrlOrigin) {
    try {
      return new URL(requestUrlOrigin).origin;
    } catch {
      return "";
    }
  }
  return "";
}

/** @param {string} value */
export function isLocalHostname(value) {
  const hostname = normalizeText(value).toLowerCase();
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]" ||
    hostname.endsWith(".localhost")
  );
}

/** @param {string} value */
function isVercelHostname(value) {
  const hostname = normalizeText(value).toLowerCase();
  return hostname === "vercel.app" || hostname.endsWith(".vercel.app");
}

/** @param {string} value */
function parseOrigin(value) {
  const normalized = normalizeBaseUrl(value);
  if (!normalized) {
    return null;
  }
  try {
    return new URL(normalized);
  } catch {
    return null;
  }
}

/**
 * @param {string} [requestOrigin]
 * @param {Record<string, string | undefined>} [env]
 */
export function resolveCodePublicBaseUrl(requestOrigin = "", env = process.env) {
  const parsedRequestOrigin = parseOrigin(requestOrigin);
  if (parsedRequestOrigin && isLocalHostname(parsedRequestOrigin.hostname)) {
    return parsedRequestOrigin.origin;
  }

  const configured = normalizeBaseUrl(env.CODE_PUBLIC_BASE_URL || "");
  if (
    parsedRequestOrigin &&
    isVercelHostname(parsedRequestOrigin.hostname) &&
    (!configured ||
      configured === DEFAULT_CODE_PUBLIC_BASE_URL ||
      parseOrigin(configured)?.hostname.toLowerCase() === DEFAULT_CODE_PUBLIC_BASE_HOSTNAME)
  ) {
    return parsedRequestOrigin.origin;
  }
  if (configured) {
    return configured;
  }
  return DEFAULT_CODE_PUBLIC_BASE_URL;
}

/** @param {Record<string, string | undefined>} [env] */
export function resolveCanonicalOauthStartUrl(env = process.env) {
  return normalizeBaseUrl(env.GH_OAUTH_START_URL || "") || DEFAULT_PUBLIC_OAUTH_START_URL;
}

/**
 * @param {{ requestOrigin?: string; env?: Record<string, string | undefined> }} [args]
 */
export function resolveCanonicalOauthCallbackUrl({
  requestOrigin = "",
  env = process.env,
} = {}) {
  const configured = normalizeBaseUrl(env.GH_OAUTH_CALLBACK_URL || "");
  if (configured) {
    return configured;
  }

  const normalizedOrigin = normalizeBaseUrl(requestOrigin);
  if (normalizedOrigin) {
    try {
      const parsed = new URL(normalizedOrigin);
      if (isLocalHostname(parsed.hostname)) {
        return `${parsed.origin}/api/github/oauth/callback`;
      }
    } catch {
      // Fall through to the canonical public origin.
    }
  }

  const canonicalStartUrl = normalizeAbsoluteUrl(resolveCanonicalOauthStartUrl(env));
  if (canonicalStartUrl) {
    try {
      const parsed = new URL(canonicalStartUrl);
      return `${parsed.origin}/api/github/oauth/callback`;
    } catch {
      // Fall through to the public base URL.
    }
  }

  return `${resolveCodePublicBaseUrl("", env)}/api/github/oauth/callback`;
}

/**
 * @param {Set<string>} target
 * @param {unknown} value
 */
function addAllowedOrigin(target, value) {
  const normalized = normalizeBaseUrl(value);
  if (!normalized) {
    return;
  }
  try {
    target.add(new URL(normalized).origin);
  } catch {
    // Ignore malformed values.
  }
}

/**
 * @param {{ requestOrigin?: string; env?: Record<string, string | undefined> }} [args]
 * @returns {string[]}
 */
export function resolveAllowedAppOrigins({
  requestOrigin = "",
  env = process.env,
} = {}) {
  /** @type {Set<string>} */
  const origins = new Set();
  const configured = normalizeText(env.CODE_ALLOWED_APP_ORIGINS || "");
  for (const candidate of configured.split(/[\s,]+/)) {
    addAllowedOrigin(origins, candidate);
  }

  addAllowedOrigin(origins, resolveCodePublicBaseUrl(requestOrigin, env));
  addAllowedOrigin(origins, resolveCanonicalOauthStartUrl(env));
  addAllowedOrigin(
    origins,
    resolveCanonicalOauthCallbackUrl({
      requestOrigin,
      env,
    }),
  );

  const normalizedOrigin = normalizeBaseUrl(requestOrigin);
  if (normalizedOrigin) {
    addAllowedOrigin(origins, normalizedOrigin);
  }

  return Array.from(origins);
}

/**
 * @param {string} origin
 * @param {string[]} [allowedOrigins]
 */
export function isAllowedAppOrigin(origin, allowedOrigins = []) {
  const normalizedOrigin = normalizeText(origin);
  if (!normalizedOrigin) {
    return false;
  }
  return allowedOrigins.some((candidate) => normalizeText(candidate) === normalizedOrigin);
}

/**
 * @param {unknown} value
 * @param {{ allowedOrigins?: string[] }} [args]
 */
export function resolveAllowedContinueTo(
  value,
  { allowedOrigins = /** @type {string[]} */ ([]) } = {},
) {
  const normalized = normalizeAbsoluteUrl(value);
  if (!normalized) {
    return "";
  }

  try {
    const parsed = new URL(normalized);
    if (!isAllowedAppOrigin(parsed.origin, allowedOrigins)) {
      return "";
    }
    return parsed.toString();
  } catch {
    return "";
  }
}

/**
 * @param {{ requestOrigin?: string; env?: Record<string, string | undefined> }} [args]
 */
export function resolveSharedSessionCookieDomain({
  requestOrigin = "",
  env = process.env,
} = {}) {
  const configured = normalizeText(env.CODE_SESSION_COOKIE_DOMAIN || "");
  if (!configured) {
    return "";
  }

  const normalized =
    configured.startsWith(".") ? configured.toLowerCase() : `.${configured.toLowerCase()}`;
  const cookieDomain = normalized.slice(1);
  if (!cookieDomain || cookieDomain.includes("/") || isLocalHostname(cookieDomain)) {
    return "";
  }

  const normalizedOrigin = normalizeBaseUrl(requestOrigin);
  if (!normalizedOrigin) {
    return normalized;
  }

  try {
    const hostname = new URL(normalizedOrigin).hostname.toLowerCase();
    if (hostname === cookieDomain || hostname.endsWith(`.${cookieDomain}`)) {
      return normalized;
    }
  } catch {
    // Ignore malformed request origins.
  }

  return "";
}

/**
 * @param {{ requestOrigin?: string; targetOrigin?: string; env?: Record<string, string | undefined> }} [args]
 */
export function canShareSessionCookieAcrossOrigins({
  requestOrigin = "",
  targetOrigin = "",
  env = process.env,
} = {}) {
  const normalizedRequestOrigin = normalizeBaseUrl(requestOrigin);
  const normalizedTargetOrigin = normalizeBaseUrl(targetOrigin);
  if (!normalizedRequestOrigin || !normalizedTargetOrigin) {
    return false;
  }
  if (normalizedRequestOrigin === normalizedTargetOrigin) {
    return true;
  }

  const requestCookieDomain = resolveSharedSessionCookieDomain({
    requestOrigin: normalizedRequestOrigin,
    env,
  });
  const targetCookieDomain = resolveSharedSessionCookieDomain({
    requestOrigin: normalizedTargetOrigin,
    env,
  });

  return Boolean(
    requestCookieDomain &&
      targetCookieDomain &&
      requestCookieDomain === targetCookieDomain,
  );
}

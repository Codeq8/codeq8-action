export function normalizeText(value) {
  return String(value ?? "").trim();
}

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

export const DEFAULT_CODE_WORKER_BASE_URL = "https://api.codeq8.com";

function resolveConfiguredWorkerBaseUrl(env = process.env, defaultWorkerUrl = "") {
  return (
    normalizeBaseUrl(env.CODE_WORKER_URL || "") ||
    normalizeBaseUrl(env.CODE_WORKER_CANONICAL_URL || "") ||
    normalizeBaseUrl(defaultWorkerUrl)
  );
}

export function resolveChatThreadWorkerBaseUrl(
  env = process.env,
  defaultWorkerUrl = "",
) {
  return resolveConfiguredWorkerBaseUrl(env, defaultWorkerUrl);
}

export function resolveChatGptAccountWorkerBaseUrl(
  env = process.env,
  defaultWorkerUrl = "",
) {
  return resolveConfiguredWorkerBaseUrl(env, defaultWorkerUrl);
}

export function resolveWorkerBaseUrl(
  env = process.env,
  defaultWorkerUrl = "",
) {
  return resolveConfiguredWorkerBaseUrl(env, defaultWorkerUrl);
}

const GITHUB_WEB_SESSION_COOKIE_NAME = "code_github_session";

const GITHUB_WEB_SESSION_COOKIE_ENV_NAMES = [
  "CODEQ8_E2E_GITHUB_WEB_SESSION_COOKIE",
  "CODEQ8_GITHUB_WEB_SESSION_COOKIE",
  "CODEQ8_TRIGGERING_GITHUB_WEB_SESSION_COOKIE",
] as const;

const RUN_TOKEN_ENV_NAMES = [
  "CODE_WEB_CHAT_RUN_TOKEN",
] as const;

const AUTH_HOST_ENV_NAMES = [
  "CODEQ8_MCP_AUTH_HOSTS",
  "PLAYWRIGHT_MCP_AUTH_HOSTS",
] as const;

const AUTH_URL_ENV_NAMES = [
  "CODEQ8_MCP_AUTH_URLS",
  "PLAYWRIGHT_MCP_AUTH_URLS",
  "CODE_DEPLOYED_PUBLIC_URL",
  "CODE_PUBLIC_BASE_URL",
  "PLAYWRIGHT_TEST_BASE_URL",
] as const;

const RUN_TOKEN_ROUTE_PROBE_NAME = "__codeq8McpRunTokenRouteProbe";
const RUN_TOKEN_ROUTE_PREFIX = "/api/chat/runs/";
const RUN_TOKEN_ROUTE_METHODS = new Set(["GET", "HEAD"]);
const RUN_TOKEN_MUTATION_ROUTES = new Map([
  ["/api/chat/runs/delegated-threads", new Set(["POST"])],
  ["/api/chat/runs/thread-archive", new Set(["POST"])],
  ["/api/chat/runs/thread-goal", new Set(["POST"])],
]);
const SECRET_FIELD_PATTERN =
  /(?:authorization|cookie|token|secret|password|private[_-]?key|webhook[_-]?secret|session)/i;
const MAX_SANITIZED_STRING_LENGTH = 2000;
const MAX_SANITIZED_ARRAY_LENGTH = 25;
const MAX_SANITIZED_OBJECT_KEYS = 60;

type EnvLike = Record<string, string | undefined>;

type CookieSameSite = "Strict" | "Lax" | "None";

type BrowserCookie = {
  httpOnly: boolean;
  name: string;
  sameSite: CookieSameSite;
  secure: boolean;
  url: string;
  value: string;
};

type BrowserContextLike = {
  addCookies(cookies: BrowserCookie[]): Promise<void>;
};

type FrameLike = {
  parentFrame?: () => unknown;
  url?: () => string;
};

type PageLike = {
  context(): BrowserContextLike;
  exposeFunction?: (
    functionName: string,
    callback: (input: unknown) => Promise<unknown>,
  ) => Promise<void>;
  on(eventName: "framenavigated", callback: (frame: FrameLike) => void): void;
  reload(options?: { waitUntil?: "domcontentloaded" }): Promise<unknown>;
  url(): string;
};

type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
  },
) => Promise<{
  ok: boolean;
  status: number;
  headers?: {
    get?(name: string): string | null;
  };
  text(): Promise<string>;
}>;

function splitEnvList(value: unknown): string[] {
  return String(value || "")
    .split(/[,\n;]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function normalizeHost(value: unknown): string {
  const raw = String(value || "").trim();
  if (!raw) {
    return "";
  }
  try {
    return new URL(raw).hostname.toLowerCase();
  } catch {
    return raw
      .replace(/^https?:\/\//i, "")
      .replace(/\/.*$/, "")
      .trim()
      .toLowerCase();
  }
}

function normalizeOrigin(value: unknown): string {
  const raw = String(value || "").trim();
  if (!raw) {
    return "";
  }
  try {
    const parsed = new URL(raw);
    return parsed.origin;
  } catch {
    return "";
  }
}

function normalizeMethod(value: unknown): string {
  return String(value || "GET").trim().toUpperCase() || "GET";
}

function normalizeText(value: unknown): string {
  return String(value ?? "").trim();
}

function normalizeBooleanFalse(value: unknown): boolean {
  return value === false || normalizeText(value).toLowerCase() === "false";
}

function payloadObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function appendQueryValue(searchParams: URLSearchParams, key: string, value: unknown) {
  if (!key || value === undefined || value === null) {
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      appendQueryValue(searchParams, key, entry);
    }
    return;
  }
  searchParams.append(key, String(value));
}

function appendQueryObject(searchParams: URLSearchParams, query: unknown) {
  for (const [key, value] of Object.entries(payloadObject(query))) {
    appendQueryValue(searchParams, key, value);
  }
}

function appendDefaultRunContext({
  env,
  input,
  searchParams,
}: {
  env: EnvLike;
  input: Record<string, unknown>;
  searchParams: URLSearchParams;
}) {
  if (input.include_run_context === false || input.includeRunContext === false) {
    return;
  }
  const defaults: Array<[string, string | undefined]> = [
    ["workspace_repository", env.CODE_WORKSPACE_REPOSITORY],
    ["thread_id", env.CODE_CHAT_THREAD_ID],
    ["run_id", env.CODE_CHAT_RUN_ID],
  ];
  for (const [key, value] of defaults) {
    const normalizedValue = normalizeText(value);
    if (!searchParams.has(key) && normalizedValue) {
      searchParams.set(key, normalizedValue);
    }
  }
}

function appendDefaultRunContextToBody({
  env,
  input,
  body,
}: {
  env: EnvLike;
  input: Record<string, unknown>;
  body: Record<string, unknown>;
}) {
  if (input.include_run_context === false || input.includeRunContext === false) {
    return;
  }
  const defaults: Array<[string, string | undefined]> = [
    ["workspace_repository", env.CODE_WORKSPACE_REPOSITORY],
    ["thread_id", env.CODE_CHAT_THREAD_ID],
    ["run_id", env.CODE_CHAT_RUN_ID],
  ];
  for (const [key, value] of defaults) {
    const normalizedValue = normalizeText(value);
    if (body[key] === undefined && normalizedValue) {
      body[key] = normalizedValue;
    }
  }
}

function isMcpProbeMutation(body: Record<string, unknown>): boolean {
  return body.mcp_probe === true || body.mcpProbe === true;
}

function readBodyText(
  body: Record<string, unknown>,
  keys: string[],
): string {
  for (const key of keys) {
    const value = normalizeText(body[key]);
    if (value) {
      return value;
    }
  }
  return "";
}

function validateRunTokenProbeMutation({
  body,
  env,
  method,
  pathname,
}: {
  body: Record<string, unknown> | undefined;
  env: EnvLike;
  method: string;
  pathname: string;
}): string {
  if (method === "GET" || method === "HEAD") {
    return "";
  }
  const bodyObject = body || {};
  if (pathname === "/api/chat/runs/delegated-threads") {
    const initialMessage = payloadObject(
      bodyObject.initial_message || bodyObject.initialMessage,
    );
    const initialMetadata = payloadObject(initialMessage.metadata);
    const assignment = readBodyText(bodyObject, [
      "assigned_to_kind",
      "assignedToKind",
      "assigned_to",
      "assignedTo",
    ]).toLowerCase();
    if (
      !isMcpProbeMutation(bodyObject) ||
      assignment !== "codeq8" ||
      !readBodyText(bodyObject, ["idempotency_key", "idempotencyKey"]) ||
      !normalizeText(initialMessage.content) ||
      !normalizeBooleanFalse(initialMetadata.dispatch)
    ) {
      return "Delegated thread create probes must be marked mcp_probe=true, assigned to codeq8, dispatch=false, and include idempotency_key.";
    }
    return "";
  }
  if (pathname === "/api/chat/runs/thread-archive") {
    const targetThreadId = readBodyText(bodyObject, [
      "target_thread_id",
      "targetThreadId",
    ]);
    if (
      !isMcpProbeMutation(bodyObject) ||
      !targetThreadId ||
      targetThreadId === normalizeText(env.CODE_CHAT_THREAD_ID)
    ) {
      return "Thread archive probes must be marked mcp_probe=true and target a non-parent thread id.";
    }
    return "";
  }
  return "";
}

function fallbackProbeBaseUrl({
  env,
  pageUrl,
}: {
  env: EnvLike;
  pageUrl: unknown;
}): string {
  return (
    normalizeOrigin(pageUrl) ||
    normalizeOrigin(env.CODE_DEPLOYED_PUBLIC_URL) ||
    normalizeOrigin(env.CODE_PUBLIC_BASE_URL) ||
    normalizeOrigin(env.PLAYWRIGHT_TEST_BASE_URL)
  );
}

function buildRunTokenProbeUrl({
  env,
  input,
  method,
  pageUrl,
}: {
  env: EnvLike;
  input: Record<string, unknown>;
  method: string;
  pageUrl: unknown;
}): URL | null {
  const rawUrl = normalizeText(input.url);
  const rawPath = normalizeText(input.path || input.pathname);
  const baseUrl = normalizeText(input.base_url || input.baseUrl) ||
    fallbackProbeBaseUrl({ env, pageUrl });
  if (!rawUrl && !rawPath) {
    return null;
  }
  if (!rawUrl && !baseUrl) {
    return null;
  }

  let targetUrl: URL;
  try {
    targetUrl = rawUrl ? new URL(rawUrl) : new URL(rawPath, baseUrl);
  } catch {
    return null;
  }
  appendQueryObject(targetUrl.searchParams, input.query);
  if (method === "GET" || method === "HEAD") {
    appendDefaultRunContext({ env, input, searchParams: targetUrl.searchParams });
  }
  return targetUrl;
}

function hostMatchesPattern(host: string, pattern: string): boolean {
  if (!host || !pattern) {
    return false;
  }
  if (pattern.includes("*")) {
    const escapedPattern = pattern
      .split("*")
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("[^.]+");
    return new RegExp(`^${escapedPattern}$`, "i").test(host);
  }
  if (pattern.startsWith("*.")) {
    const suffix = pattern.slice(1).toLowerCase();
    return host.endsWith(suffix) && host.length > suffix.length;
  }
  if (pattern.startsWith(".")) {
    return host.endsWith(pattern.toLowerCase()) && host.length > pattern.length;
  }
  return host === pattern.toLowerCase();
}

export function normalizeCodeq8McpAuthCookie(value: unknown): string {
  const raw = String(value || "").trim();
  if (!raw) {
    return "";
  }
  for (const cookiePart of raw.split(";")) {
    const [name, ...rest] = cookiePart.trim().split("=");
    if (name === GITHUB_WEB_SESSION_COOKIE_NAME) {
      return rest.join("=").trim();
    }
  }
  return raw;
}

export function readCodeq8McpAuthCookie(env: EnvLike = process.env): string {
  for (const envName of GITHUB_WEB_SESSION_COOKIE_ENV_NAMES) {
    const cookie = normalizeCodeq8McpAuthCookie(env[envName]);
    if (cookie) {
      return cookie;
    }
  }
  return "";
}

export function readCodeq8McpRunToken(env: EnvLike = process.env): string {
  for (const envName of RUN_TOKEN_ENV_NAMES) {
    const token = normalizeText(env[envName]);
    if (token) {
      return token;
    }
  }
  return "";
}

export function listCodeq8McpAuthHosts(env: EnvLike = process.env): string[] {
  const hosts = new Set<string>([
    "localhost",
    "127.0.0.1",
    "::1",
    "codeq8-git-*.vercel.app",
  ]);
  for (const envName of AUTH_HOST_ENV_NAMES) {
    for (const entry of splitEnvList(env[envName])) {
      const host = normalizeHost(entry);
      if (host) {
        hosts.add(host);
      }
    }
  }
  return Array.from(hosts);
}

export function isCodeq8McpAuthHostAllowed({
  env = process.env,
  host,
}: {
  env?: EnvLike;
  host: unknown;
}): boolean {
  const normalizedHost = normalizeHost(host);
  if (!normalizedHost) {
    return false;
  }
  return listCodeq8McpAuthHosts(env).some((pattern) =>
    hostMatchesPattern(normalizedHost, pattern),
  );
}

export function listCodeq8McpAuthOrigins(env: EnvLike = process.env): string[] {
  const origins = new Set<string>();
  for (const envName of AUTH_URL_ENV_NAMES) {
    for (const entry of splitEnvList(env[envName])) {
      const origin = normalizeOrigin(entry);
      if (origin && isCodeq8McpAuthHostAllowed({ env, host: origin })) {
        origins.add(origin);
      }
    }
  }
  return Array.from(origins);
}

export function isCodeq8McpRunTokenRouteAllowed({
  env = process.env,
  method,
  targetUrl,
}: {
  env?: EnvLike;
  method: unknown;
  targetUrl: unknown;
}): boolean {
  const normalizedMethod = normalizeMethod(method);
  let parsed: URL;
  try {
    parsed = new URL(String(targetUrl || ""));
  } catch {
    return false;
  }
  if (!isCodeq8McpAuthHostAllowed({ env, host: parsed.hostname })) {
    return false;
  }
  if (RUN_TOKEN_ROUTE_METHODS.has(normalizedMethod)) {
    return parsed.pathname.startsWith(RUN_TOKEN_ROUTE_PREFIX);
  }
  const allowedMutationMethods = RUN_TOKEN_MUTATION_ROUTES.get(parsed.pathname);
  return Boolean(allowedMutationMethods?.has(normalizedMethod));
}

function buildRunTokenProbeJsonBodyPayload({
  env,
  input,
  method,
}: {
  env: EnvLike;
  input: Record<string, unknown>;
  method: string;
}): Record<string, unknown> | undefined {
  if (method === "GET" || method === "HEAD") {
    return undefined;
  }
  const body = {
    ...payloadObject(input.body || input.json || input.payload),
  };
  appendDefaultRunContextToBody({ env, input, body });
  return body;
}

function sanitizeMcpProbePayload(value: unknown, key = "", depth = 0): unknown {
  if (SECRET_FIELD_PATTERN.test(key)) {
    return "[redacted]";
  }
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value === "string") {
    if (/code_github_session=|Bearer\s+\S+|authorization=/i.test(value)) {
      return "[redacted]";
    }
    return value.length > MAX_SANITIZED_STRING_LENGTH
      ? `${value.slice(0, MAX_SANITIZED_STRING_LENGTH)}...[truncated]`
      : value;
  }
  if (typeof value !== "object") {
    return value;
  }
  if (depth >= 5) {
    return "[max-depth]";
  }
  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_SANITIZED_ARRAY_LENGTH)
      .map((entry) => sanitizeMcpProbePayload(entry, "", depth + 1));
  }
  const result: Record<string, unknown> = {};
  for (const [entryKey, entryValue] of Object.entries(value as Record<string, unknown>)
    .slice(0, MAX_SANITIZED_OBJECT_KEYS)) {
    result[entryKey] = sanitizeMcpProbePayload(entryValue, entryKey, depth + 1);
  }
  return result;
}

function contentTypeFromHeaders(headers: unknown): string {
  const candidate = headers && typeof headers === "object" ? headers as {
    get?: (name: string) => string | null;
  } : {};
  return normalizeText(typeof candidate.get === "function"
    ? candidate.get("content-type")
    : "");
}

export async function requestCodeq8McpRunTokenRoute({
  env = process.env,
  fetchImpl = globalThis.fetch as unknown as FetchLike,
  input,
  pageUrl,
}: {
  env?: EnvLike;
  fetchImpl?: FetchLike;
  input: unknown;
  pageUrl?: unknown;
}): Promise<Record<string, unknown>> {
  const token = readCodeq8McpRunToken(env);
  if (!token) {
    return {
      ok: false,
      blocked: true,
      error: "CODE_WEB_CHAT_RUN_TOKEN is unavailable to the Codeq8 MCP route probe.",
    };
  }
  if (typeof fetchImpl !== "function") {
    return {
      ok: false,
      blocked: true,
      error: "Fetch is unavailable to the Codeq8 MCP route probe.",
    };
  }

  const inputObject = payloadObject(input);
  const method = normalizeMethod(inputObject.method);
  const targetUrl = buildRunTokenProbeUrl({
    env,
    input: inputObject,
    method,
    pageUrl,
  });
  if (!targetUrl || !isCodeq8McpRunTokenRouteAllowed({ env, method, targetUrl })) {
    return {
      ok: false,
      blocked: true,
      error: "Codeq8 MCP route probe target is not an allowed run-token route.",
      method,
      url: targetUrl ? `${targetUrl.origin}${targetUrl.pathname}` : "",
    };
  }

  const bodyPayload = buildRunTokenProbeJsonBodyPayload({
    env,
    input: inputObject,
    method,
  });
  const mutationError = validateRunTokenProbeMutation({
    body: bodyPayload,
    env,
    method,
    pathname: targetUrl.pathname,
  });
  if (mutationError) {
    return {
      ok: false,
      blocked: true,
      error: `Codeq8 MCP route probe mutation is not allowed: ${mutationError}`,
      method,
      url: `${targetUrl.origin}${targetUrl.pathname}`,
    };
  }
  const body = bodyPayload ? JSON.stringify(bodyPayload) : undefined;
  const sessionCookie = readCodeq8McpAuthCookie(env);
  const response = await fetchImpl(targetUrl.toString(), {
    method,
    headers: {
      accept: "application/json",
      authorization: `Bearer ${token}`,
      ...(sessionCookie
        ? { cookie: `${GITHUB_WEB_SESSION_COOKIE_NAME}=${sessionCookie}` }
        : {}),
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body } : {}),
  });
  const text = await response.text();
  let json: unknown = undefined;
  let textPrefix = "";
  try {
    json = JSON.parse(text);
  } catch {
    textPrefix = text.slice(0, MAX_SANITIZED_STRING_LENGTH);
  }
  return {
    ok: Boolean(response.ok),
    status: Number(response.status || 0),
    method,
    url: `${targetUrl.origin}${targetUrl.pathname}${targetUrl.search}`,
    content_type: contentTypeFromHeaders(response.headers),
    ...(json === undefined
      ? { text: sanitizeMcpProbePayload(textPrefix) }
      : { json: sanitizeMcpProbePayload(json) }),
  };
}

export async function exposeCodeq8McpRunTokenRouteProbe({
  env = process.env,
  fetchImpl,
  page,
}: {
  env?: EnvLike;
  fetchImpl?: FetchLike;
  page: PageLike;
}): Promise<boolean> {
  if (typeof page.exposeFunction !== "function") {
    return false;
  }
  await page.exposeFunction(RUN_TOKEN_ROUTE_PROBE_NAME, async (input: unknown) =>
    requestCodeq8McpRunTokenRoute({
      env,
      fetchImpl,
      input,
      pageUrl: page.url(),
    }));
  return true;
}

export async function seedCodeq8McpAuthCookie({
  env = process.env,
  page,
  targetUrl,
}: {
  env?: EnvLike;
  page: PageLike;
  targetUrl: unknown;
}): Promise<boolean> {
  const cookie = readCodeq8McpAuthCookie(env);
  const origin = normalizeOrigin(targetUrl);
  if (!cookie || !origin || !isCodeq8McpAuthHostAllowed({ env, host: origin })) {
    return false;
  }
  await page.context().addCookies([
    {
      httpOnly: true,
      name: GITHUB_WEB_SESSION_COOKIE_NAME,
      sameSite: "Lax",
      secure: new URL(origin).protocol === "https:",
      url: origin,
      value: cookie,
    },
  ]);
  return true;
}

export default async function initCodeq8PlaywrightMcpAuth({
  env = process.env,
  page,
}: {
  env?: EnvLike;
  page: PageLike;
}) {
  await exposeCodeq8McpRunTokenRouteProbe({ env, page });

  if (!readCodeq8McpAuthCookie(env)) {
    return;
  }

  const seededOrigins = new Set<string>();
  const seedOrigin = async (targetUrl: unknown): Promise<boolean> => {
    const origin = normalizeOrigin(targetUrl);
    if (!origin || seededOrigins.has(origin)) {
      return false;
    }
    const seeded = await seedCodeq8McpAuthCookie({ env, page, targetUrl: origin });
    if (seeded) {
      seededOrigins.add(origin);
    }
    return seeded;
  };

  for (const origin of listCodeq8McpAuthOrigins(env)) {
    await seedOrigin(origin);
  }

  await seedOrigin(page.url());

  const reloadedOrigins = new Set<string>();
  page.on("framenavigated", (frame) => {
    if (typeof frame.parentFrame === "function" && frame.parentFrame()) {
      return;
    }
    const targetUrl = typeof frame.url === "function" ? frame.url() : "";
    const origin = normalizeOrigin(targetUrl);
    if (!origin || reloadedOrigins.has(origin)) {
      return;
    }
    void seedOrigin(origin).then(async (seeded) => {
      if (!seeded) {
        return;
      }
      reloadedOrigins.add(origin);
      await page.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
    });
  });
}

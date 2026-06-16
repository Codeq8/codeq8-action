const GITHUB_WEB_SESSION_COOKIE_NAME = "code_github_session";

const GITHUB_WEB_SESSION_COOKIE_ENV_NAMES = [
  "CODEQ8_E2E_GITHUB_WEB_SESSION_COOKIE",
  "CODEQ8_GITHUB_WEB_SESSION_COOKIE",
  "CODEQ8_TRIGGERING_GITHUB_WEB_SESSION_COOKIE",
] as const;

const AUTH_HOST_ENV_NAMES = [
  "CODEQ8_MCP_AUTH_HOSTS",
  "PLAYWRIGHT_MCP_AUTH_HOSTS",
] as const;

const AUTH_URL_ENV_NAMES = [
  "CODEQ8_MCP_AUTH_URLS",
  "PLAYWRIGHT_MCP_AUTH_URLS",
  "CODE_DEPLOYED_PUBLIC_URL",
  "PLAYWRIGHT_TEST_BASE_URL",
] as const;

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
  on(eventName: "framenavigated", callback: (frame: FrameLike) => void): void;
  reload(options?: { waitUntil?: "domcontentloaded" }): Promise<unknown>;
  url(): string;
};

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

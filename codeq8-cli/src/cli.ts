import process from "node:process";
import { spawn } from "node:child_process";
import readline from "node:readline/promises";

import {
  clearAuthState,
  readAuthState,
  resolveAuthStorageBackend,
  resolveNormalizedBaseUrl,
  writeAuthState,
} from "./auth-store.js";
import { handleChat } from "./cli-chat-commands.js";
import { handleGitHub } from "./cli-github-commands.js";
import { readVersion, renderAuthHelp, renderHelp, renderRepoHelp } from "./cli-help.js";
import { handleRunnerCodeq8Cli } from "./runner-helper.js";
import {
  consumeAllOptions,
  consumeOption,
  extractError,
  normalize,
  parseFlag,
  print,
  printError,
  readStdinText,
} from "./cli-command-utils.js";
import type {
  ApiJsonRequestOptions,
  ApiJsonResponse,
  AuthedApiJsonRequestOptions,
  AuthState,
  BaseCommandContext,
} from "./cli-types.js";

async function apiJsonRequest({
  baseUrl,
  path,
  method = "GET",
  token = "",
  query = null,
  body = null,
}: ApiJsonRequestOptions): Promise<ApiJsonResponse> {
  const base = resolveNormalizedBaseUrl(baseUrl);
  const url = new URL(path, `${base}/`);

  if (query && typeof query === "object") {
    for (const [key, value] of Object.entries(query)) {
      const normalized = normalize(value);
      if (!normalized) {
        continue;
      }
      url.searchParams.set(key, normalized);
    }
  }

  const response = await fetch(url.toString(), {
    method,
    headers: {
      Accept: "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    cache: "no-store",
  });

  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = { ok: false, error: `Non-JSON response (${response.status}).` };
  }

  return {
    ok: response.ok && (!payload || payload.ok !== false),
    status: response.status,
    payload,
  };
}

function isInteractiveSession(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

function isUnauthorizedResponse(response: ApiJsonResponse | null | undefined): boolean {
  if (!response || typeof response !== "object") {
    return false;
  }

  const status = Number(response.status || 0);
  if (status === 401 || status === 403) {
    return true;
  }

  const errorText = normalize(response.payload?.error).toLowerCase();
  return (
    errorText.includes("unauthorized") ||
    errorText.includes("not authenticated") ||
    errorText.includes("invalid token")
  );
}

function openBrowser(url: unknown): boolean {
  const normalizedUrl = normalize(url);
  if (!normalizedUrl) {
    return false;
  }

  let command = "";
  let args: string[] = [];
  if (process.platform === "darwin") {
    command = "open";
    args = [normalizedUrl];
  } else if (process.platform === "win32") {
    command = "cmd";
    args = ["/c", "start", "", normalizedUrl];
  } else {
    command = "xdg-open";
    args = [normalizedUrl];
  }

  try {
    const child = spawn(command, args, {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

async function promptForInput(promptText: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const answer = await rl.question(promptText);
    return normalize(answer);
  } finally {
    rl.close();
  }
}

async function requireAuthToken({
  baseUrl,
  autoLogin = false,
  autoLoginMessage = "Not logged in. Starting login...",
}: {
  baseUrl?: string;
  autoLogin?: boolean;
  autoLoginMessage?: string;
}): Promise<AuthState> {
  const auth = await readAuthState({ baseUrl });
  if (auth && normalize(auth.token)) {
    return auth;
  }

  if (autoLogin && isInteractiveSession()) {
    if (normalize(autoLoginMessage)) {
      print(autoLoginMessage);
    }
    const loginExitCode = await handleAuth(["login"], { baseUrl });
    if (loginExitCode === 0) {
      const refreshed = await readAuthState({ baseUrl });
      if (refreshed && normalize(refreshed.token)) {
        return refreshed;
      }
    }
    throw new Error("Login failed. Run `codeq8 login` to retry.");
  }

  const loginHint = isInteractiveSession()
    ? "Run `codeq8 login` first."
    : "Non-interactive mode detected. Run `codeq8 login --with-token --token <github_token>` first.";
  throw new Error(`Not logged in. ${loginHint}`);
}

async function authedApiJsonRequest({
  baseUrl,
  path,
  method = "GET",
  query = null,
  body = null,
  autoLogin = false,
}: AuthedApiJsonRequestOptions): Promise<ApiJsonResponse> {
  let auth = await requireAuthToken({ baseUrl, autoLogin });

  let response = await apiJsonRequest({
    baseUrl,
    path,
    method,
    token: auth.token,
    query,
    body,
  });

  if (response.ok || !isUnauthorizedResponse(response)) {
    return response;
  }

  await clearAuthState({ baseUrl }).catch(() => {
    // best effort; continue with current response if local clear fails
  });

  if (!autoLogin || !isInteractiveSession()) {
    return response;
  }

  print("Session expired or invalid. Starting login...");
  try {
    auth = await requireAuthToken({
      baseUrl,
      autoLogin: true,
      autoLoginMessage: "",
    });
  } catch {
    return response;
  }

  response = await apiJsonRequest({
    baseUrl,
    path,
    method,
    token: auth.token,
    query,
    body,
  });
  return response;
}

async function validateAndPersistSessionToken({
  baseUrl,
  sessionToken,
}: {
  baseUrl?: string;
  sessionToken: string;
}): Promise<{ githubLogin: string; expiresAt: number }> {
  const status = await apiJsonRequest({
    baseUrl,
    path: "/api/cli/auth/status",
    method: "GET",
    token: sessionToken,
  });
  if (!status.ok) {
    throw new Error(extractError(status.payload, `Unable to validate token (${status.status}).`));
  }

  await writeAuthState({
    token: sessionToken,
    tokenType: "bearer",
    baseUrl,
  });

  return {
    githubLogin: normalize(status.payload?.github_login),
    expiresAt: Number(status.payload?.expires_at || 0) || 0,
  };
}

async function handleAuth(args: string[], { baseUrl }: BaseCommandContext): Promise<number> {
  const [subcommand = "", ...rest] = args;

  if (!subcommand || subcommand === "--help" || subcommand === "-h") {
    print(renderAuthHelp());
    return 0;
  }

  if (subcommand === "login") {
    let options = rest.slice();
    const withToken = parseFlag(options, ["--with-token"]);
    options = options.filter((arg) => arg !== "--with-token");
    const consumed = consumeOption(options, "--token");
    const tokenArg = consumed.value;
    options = consumed.args;

    if (options.length > 0) {
      throw new Error(`Unknown auth login option: ${options[0]}`);
    }

    if (withToken) {
      let githubToken = normalize(tokenArg);
      if (!githubToken) {
        const stdinToken = normalize(await readStdinText());
        githubToken = normalize(stdinToken);
      }
      if (!githubToken) {
        printError("No token provided. Use --token or pipe token to stdin.");
        return 1;
      }

      const exchange = await apiJsonRequest({
        baseUrl,
        path: "/api/cli/auth/exchange",
        method: "POST",
        body: { github_token: githubToken },
      });
      if (!exchange.ok) {
        printError(extractError(exchange.payload, `Login failed (${exchange.status}).`));
        return 1;
      }

      const sessionToken = normalize(exchange.payload?.token);
      if (!sessionToken) {
        printError("Login response did not include a session token.");
        return 1;
      }

      await writeAuthState({
        token: sessionToken,
        tokenType: normalize(exchange.payload?.token_type) || "bearer",
        baseUrl,
      });

      const login = normalize(exchange.payload?.github_login);
      print(`Logged in${login ? ` as ${login}` : ""}.`);
      return 0;
    }

    const startUrl = new URL("/api/cli/auth/start", `${baseUrl}/`).toString();
    const launched = openBrowser(startUrl);
    if (launched) {
      print(`Opened browser for login: ${startUrl}`);
    } else {
      print(`Open this URL to login: ${startUrl}`);
    }

    if (!process.stdin.isTTY) {
      printError("Interactive login requires a TTY. Use --with-token in headless mode.");
      return 1;
    }

    const pastedToken = await promptForInput("Paste CLI token from browser: ");
    if (!pastedToken) {
      printError("No token entered.");
      return 1;
    }

    try {
      const validated = await validateAndPersistSessionToken({
        baseUrl,
        sessionToken: pastedToken,
      });
      print(
        `Logged in${validated.githubLogin ? ` as ${validated.githubLogin}` : ""}.`,
      );
      return 0;
    } catch (error) {
      printError(error instanceof Error ? error.message : "Unable to validate session token.");
      return 1;
    }
  }

  if (subcommand === "status") {
    const json = parseFlag(rest, ["--json"]);
    const extras = rest.filter((arg) => arg !== "--json");
    if (extras.length > 0) {
      throw new Error(`Unknown auth status option: ${extras[0]}`);
    }

    const auth = await readAuthState({ baseUrl });
    if (!auth) {
      if (json) {
        print(JSON.stringify({ authenticated: false }, null, 2));
      } else {
        print("Not logged in.");
      }
      return 0;
    }

    const status = await apiJsonRequest({
      baseUrl,
      path: "/api/cli/auth/status",
      method: "GET",
      token: auth.token,
    });

    if (!status.ok) {
      const errorMessage = extractError(status.payload, `Auth status failed (${status.status}).`);
      if (json) {
        print(
          JSON.stringify(
            {
              authenticated: false,
              error: errorMessage,
            },
            null,
            2,
          ),
        );
      } else {
        print(`Not authenticated (${errorMessage}).`);
      }
      return 1;
    }

    const payload = {
      authenticated: true,
      github_login: normalize(status.payload?.github_login),
      expires_at: Number(status.payload?.expires_at || 0) || 0,
      storage_backend: auth.backend || resolveAuthStorageBackend(),
      base_url: resolveNormalizedBaseUrl(baseUrl),
    };

    if (json) {
      print(JSON.stringify(payload, null, 2));
      return 0;
    }

    const expiryText = payload.expires_at
      ? ` expires ${new Date(payload.expires_at * 1000).toISOString()}`
      : "";
    print(
      `Logged in${payload.github_login ? ` as ${payload.github_login}` : ""} via ${payload.storage_backend}.${expiryText}`,
    );
    return 0;
  }

  if (subcommand === "logout") {
    if (rest.length > 0) {
      throw new Error(`Unknown auth logout option: ${rest[0]}`);
    }

    const auth = await readAuthState({ baseUrl });
    if (auth?.token) {
      await apiJsonRequest({
        baseUrl,
        path: "/api/cli/auth/logout",
        method: "POST",
        token: auth.token,
      }).catch(() => {
        // no-op; logout is local state clear first
      });
    }

    await clearAuthState({ baseUrl });
    print("Logged out.");
    return 0;
  }

  throw new Error(`Unknown auth subcommand: ${subcommand}`);
}

async function handleLoginCommand(
  args: string[],
  { baseUrl }: BaseCommandContext,
): Promise<number> {
  if (args[0] === "--help" || args[0] === "-h") {
    print(renderAuthHelp());
    return 0;
  }
  const [subcommand = "", ...rest] = args;
  if (subcommand === "status") {
    return await handleAuth(["status", ...rest], { baseUrl });
  }
  return await handleAuth(["login", ...args], { baseUrl });
}

async function handleLogoutCommand(
  args: string[],
  { baseUrl }: BaseCommandContext,
): Promise<number> {
  if (args[0] === "--help" || args[0] === "-h") {
    print(renderAuthHelp());
    return 0;
  }
  return await handleAuth(["logout", ...args], { baseUrl });
}

async function handleRepo(args: string[], { baseUrl }: BaseCommandContext): Promise<number> {
  const [subcommand = "", ...rest] = args;
  if (!subcommand || subcommand === "--help" || subcommand === "-h") {
    print(renderRepoHelp());
    return 0;
  }
  if (subcommand !== "list") {
    throw new Error(renderRepoHelp());
  }

  const json = parseFlag(rest, ["--json"]);
  const extras = rest.filter((arg) => arg !== "--json");
  if (extras.length > 0) {
    throw new Error(`Unknown repo list option: ${extras[0]}`);
  }

  const response = await authedApiJsonRequest({
    baseUrl,
    path: "/api/cli/repos",
    method: "GET",
    autoLogin: !json,
  });

  if (!response.ok) {
    printError(extractError(response.payload, `Unable to list repositories (${response.status}).`));
    return 1;
  }

  const repositories = Array.isArray(response.payload?.repositories)
    ? response.payload.repositories.map((entry: unknown) => normalize(entry)).filter(Boolean)
    : [];

  if (json) {
    print(
      JSON.stringify(
        {
          ok: true,
          repositories,
        },
        null,
        2,
      ),
    );
    return 0;
  }

  if (repositories.length === 0) {
    print("No repositories available.");
    return 0;
  }

  for (const repository of repositories) {
    print(repository);
  }
  return 0;
}

function parseGlobalOptions(argv: readonly unknown[]): { args: string[]; baseUrl: string } {
  let args = Array.isArray(argv) ? argv.map((arg) => String(arg)) : [];
  const baseUrlConsumed = consumeAllOptions(args, "--base-url");
  args = baseUrlConsumed.args;
  return {
    args,
    baseUrl: resolveNormalizedBaseUrl(baseUrlConsumed.value || process.env.CODEQ8_BASE_URL || "https://codeq8.com"),
  };
}

function hasRunnerHelperEnvironment(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(
    normalize(env.CODE_WEB_CHAT_RUN_TOKEN) &&
      normalize(env.CODE_CHAT_THREAD_ID) &&
      normalize(env.CODE_CHAT_RUN_ID) &&
      normalize(env.CODE_WORKSPACE_REPOSITORY),
  );
}

function isRunnerHelperCommand(args: readonly string[]): boolean {
  const [command = "", resource = "", subcommand = ""] = args;
  if (["threads", "thread", "attachments", "attachment"].includes(command)) {
    return true;
  }
  return command === "github" && resource === "issue" && ["attachments", "attachment"].includes(subcommand);
}

export async function runCli(argv: readonly unknown[]): Promise<number> {
  const global = parseGlobalOptions(argv);
  const args = global.args;
  const baseUrl = global.baseUrl;

  const [command = "", ...rest] = args;

  if (!command || command === "--help" || command === "-h") {
    print(renderHelp());
    return 0;
  }

  if (command === "--version" || command === "-v") {
    print(await readVersion());
    return 0;
  }

  if (hasRunnerHelperEnvironment() && isRunnerHelperCommand(args)) {
    return await handleRunnerCodeq8Cli({ argv: args });
  }

  if (isRunnerHelperCommand(args)) {
    printError(
      [
        "This command is a Codeq8 runner helper command and requires runner-scoped environment variables.",
        "In a local shell, use `codeq8 chat thread ...` after `codeq8 login` for the public CLI surface.",
      ].join(" "),
    );
    return 1;
  }

  if (command === "login") {
    return await handleLoginCommand(rest, { baseUrl });
  }

  if (command === "logout") {
    return await handleLogoutCommand(rest, { baseUrl });
  }

  if (command === "auth") {
    return await handleAuth(rest, { baseUrl });
  }

  if (command === "repo") {
    return await handleRepo(rest, { baseUrl });
  }

  if (command === "github") {
    return await handleGitHub(rest, { baseUrl, authedApiJsonRequest });
  }

  if (command === "chat") {
    return await handleChat(rest, { baseUrl, authedApiJsonRequest });
  }

  throw new Error(`Unknown command: ${command}`);
}

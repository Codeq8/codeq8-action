import { readFile } from "node:fs/promises";

import { normalize } from "./cli-command-utils.js";

export function renderHelp(): string {
  return [
    "Codeq8 CLI",
    "",
    "Usage:",
    "  codeq8 <command> [subcommand] [options]",
    "",
    "Commands:",
    "  login [--with-token] [--token <token>] [--base-url <url>]",
    "  login status [--json] [--base-url <url>]",
    "  logout [--base-url <url>]",
    "  auth <login|status|logout> [options] [--base-url <url>] (legacy alias)",
    "  repo list [--json] [--base-url <url>]",
    "  threads ...       Runner helper commands when Codeq8 runner env is present",
    "  attachments ...   Runner helper attachment commands when Codeq8 runner env is present",
    "  github issue view <url|number> [--repo <owner/repo>] [--comments] [--json] [--base-url <url>]",
    "  github issue comment <url|number> [--repo <owner/repo>] --body <text> [--json] [--base-url <url>]",
    "  github issue create --repo <owner/repo> --title <text> [--body <text>] [--assignee <login>] [--label <name>] [--milestone <number>] [--json] [--base-url <url>]",
    "  github issue update <url|number> [--repo <owner/repo>] [--title <text>] [--body <text>] [--state <open|closed>] [--assignee <login>] [--label <name>] [--milestone <number|none>] [--json] [--base-url <url>]",
    "  github pr view <url|number> [--repo <owner/repo>] [--comments] [--json] [--base-url <url>]",
    "  github pr comment <url|number> [--repo <owner/repo>] --body <text> [--json] [--base-url <url>]",
    "  chat thread list [--repo <owner/repo>] [--status <active|archived|closed|inactive>] [--limit <n>] [--before-updated-at <ms>] [--before-thread-id <id>] [--json] [--base-url <url>]",
    "  chat thread create [--repo <owner/repo>] [--title <text>] [--source-type <default_branch|branch|pull_request>] [--branch <name>] [--pull-request <n|url>] [--issue <n|url>] [--json] [--base-url <url>]",
    "  chat thread show <thread-id> [--json] [--base-url <url>]",
    "  chat thread messages <thread-id> [--limit <n>] [--before-created-at <ms>] [--before-message-id <id>] [--json] [--base-url <url>]",
    "  chat thread send <thread-id> [--content <text>] [--role <user|system>] [--no-dispatch] [--json] [--base-url <url>]",
    "  chat thread set-title <thread-id> <title> [--json] [--base-url <url>]",
    "  chat thread target-pr <thread-id> <pr-number-or-url> [--json] [--base-url <url>]",
    "  chat thread target-branch <thread-id> <branch> [--json] [--base-url <url>]",
    "  chat thread clear-target <thread-id> [--json] [--base-url <url>]",
    "",
    "Global options:",
    "  --base-url <url>  Override Codeq8 API base URL (default: https://codeq8.com)",
    "  -h, --help        Show help",
    "  -v, --version     Show version",
  ].join("\n");
}

export function renderAuthHelp(): string {
  return [
    "Codeq8 CLI - auth",
    "",
    "Usage:",
    "  codeq8 auth <login|status|logout> [options]",
    "  codeq8 login [--with-token] [--token <token>]",
    "  codeq8 login status [--json]",
    "  codeq8 logout",
  ].join("\n");
}

export function renderRepoHelp(): string {
  return [
    "Codeq8 CLI - repo",
    "",
    "Usage:",
    "  codeq8 repo list [--json]",
  ].join("\n");
}

export function renderGitHubHelp(): string {
  return [
    "Codeq8 CLI - github",
    "",
    "Usage:",
    "  codeq8 github <issue|pr> ...",
    "",
    "Buckets:",
    "  codeq8 github issue --help",
    "  codeq8 github pr --help",
  ].join("\n");
}

export function renderGitHubIssueHelp(): string {
  return [
    "Codeq8 CLI - github issue",
    "",
    "Usage:",
    "  codeq8 github issue view <url|number> [--repo <owner/repo>] [--comments] [--json]",
    "  codeq8 github issue comment <url|number> [--repo <owner/repo>] --body <text> [--json]",
    "  codeq8 github issue create --repo <owner/repo> --title <text> [--body <text>] [--assignee <login>] [--label <name>] [--milestone <number>] [--json]",
    "  codeq8 github issue update <url|number> [--repo <owner/repo>] [--title <text>] [--body <text>] [--state <open|closed>] [--assignee <login>] [--label <name>] [--milestone <number|none>] [--json]",
  ].join("\n");
}

export function renderGitHubPrHelp(): string {
  return [
    "Codeq8 CLI - github pr",
    "",
    "Usage:",
    "  codeq8 github pr view <url|number> [--repo <owner/repo>] [--comments] [--json]",
    "  codeq8 github pr comment <url|number> [--repo <owner/repo>] --body <text> [--json]",
  ].join("\n");
}

export function renderChatHelp(): string {
  return [
    "Codeq8 CLI - chat",
    "",
    "Usage:",
    "  codeq8 chat thread --help",
  ].join("\n");
}

export function renderChatThreadHelp(): string {
  return [
    "Codeq8 CLI - chat thread",
    "",
    "Usage:",
    "  codeq8 chat thread list [--repo <owner/repo>] [--status <active|archived|closed|inactive>] [--limit <n>] [--before-updated-at <ms>] [--before-thread-id <id>] [--json]",
    "  codeq8 chat thread create [--repo <owner/repo>] [--title <text>] [--source-type <default_branch|branch|pull_request>] [--branch <name>] [--pull-request <n|url>] [--issue <n|url>] [--json]",
    "  codeq8 chat thread show <thread-id> [--json]",
    "  codeq8 chat thread messages <thread-id> [--limit <n>] [--before-created-at <ms>] [--before-message-id <id>] [--json]",
    "  codeq8 chat thread send <thread-id> [--content <text>] [--role <user|system>] [--no-dispatch] [--json]",
    "  codeq8 chat thread set-title <thread-id> <title> [--json]",
    "  codeq8 chat thread target-pr <thread-id> <pr-number-or-url> [--json]",
    "  codeq8 chat thread target-branch <thread-id> <branch> [--json]",
    "  codeq8 chat thread clear-target <thread-id> [--json]",
  ].join("\n");
}

export async function readVersion(): Promise<string> {
  try {
    const raw = await readFile(new URL("../package.json", import.meta.url), "utf8");
    const payload = JSON.parse(raw);
    return normalize(payload.version) || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

# codeq8 CLI

This directory contains the standalone npm CLI package for Codeq8.

## Install

```bash
npm i -g @codeq8/codeq8
```

## Commands

Bucket help is available with `--help`, for example:

- `codeq8 github --help`
- `codeq8 github issue --help`
- `codeq8 chat --help`
- `codeq8 chat thread --help`

- `codeq8 login` (browser-based flow with paste-back token)
- `codeq8 login --with-token [--token <github_token>]`
- `codeq8 login status [--json]`
- `codeq8 logout` (revokes CLI session token server-side and clears local storage)
- `codeq8 repo list [--json]`
- `codeq8 threads ...` runner helper commands when Codeq8 runner-scoped env is present
- `codeq8 attachments ...` runner helper commands when Codeq8 runner-scoped env is present
- `codeq8 github issue attachments <url|number> [--repo owner/repo] [--comments] --output-dir <dir>` when Codeq8 runner-scoped env is present
- `codeq8 github issue view <url|number> [--repo owner/repo] [--comments] [--json]`
- `codeq8 github issue comment <url|number> [--repo owner/repo] --body <text> [--json]`
- `codeq8 github issue create --repo owner/repo --title <text> [--body <text>] [--assignee <login>] [--label <name>] [--milestone <number>] [--json]`
- `codeq8 github issue update <url|number> [--repo owner/repo] [--title <text>] [--body <text>] [--state <open|closed>] [--assignee <login>] [--label <name>] [--milestone <number|none>] [--json]`
- `codeq8 github pr view <url|number> [--repo owner/repo] [--comments] [--json]`
- `codeq8 github pr comment <url|number> [--repo owner/repo] --body <text> [--json]`
- `codeq8 chat thread list [--repo owner/repo] [--status <active|archived|closed|inactive>] [--limit <n>] [--before-updated-at <ms>] [--before-thread-id <id>] [--json]`
- `codeq8 chat thread create [--repo owner/repo] [--title <text>] [--source-type <default_branch|branch|pull_request>] [--branch <name>] [--pull-request <n|url>] [--issue <n|url>] [--json]`
- `codeq8 chat thread show <thread-id> [--json]`
- `codeq8 chat thread messages <thread-id> [--limit <n>] [--before-created-at <ms>] [--before-message-id <id>] [--json]`
- `codeq8 chat thread send <thread-id> [--content <text>] [--role <user|system>] [--no-dispatch] [--json]`
- `codeq8 chat thread target-pr <thread-id> <pr-number-or-url> [--json]`
- `codeq8 chat thread target-branch <thread-id> <branch> [--json]`
- `codeq8 chat thread clear-target <thread-id> [--json]`

Legacy aliases remain supported:

- `codeq8 auth login`
- `codeq8 auth status`
- `codeq8 auth logout`

## Local usage

```bash
cd codeq8-cli
npm test
npm run build
node ./bin/codeq8.js --help
```

## Configuration

- API base URL:
  - `CODEQ8_BASE_URL` (default: `https://codeq8.com`)
  - or CLI flag: `--base-url <url>`
- Auth storage mode:
  - `CODEQ8_AUTH_STORAGE=auto|keychain|file` (default: `auto`)

## Token storage

- Preferred (macOS): Keychain entry (`service=codeq8-cli`, account scoped by API host)
- Fallback: file under `$CODEQ8_CONFIG_HOME` or `$XDG_CONFIG_HOME/codeq8` or `~/.config/codeq8`

File-based fallback enforces restrictive permissions where supported.

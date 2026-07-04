---
name: codeq8-mcp
description: Use when a Codeq8 run needs to add, use, configure, review, or reason about MCP servers, MCP tools, plugin-bundled MCP capabilities, workspace MCP config, or third-party MCP auth for Codeq8-managed runs.
---

# Codeq8 MCP

Use this skill as the decision router for MCP requests in Codeq8 runs. Classify
ownership before reading vendor setup docs or proposing commands.

## Core Rule

MCP is a capability boundary, not a permission grant. First decide whether the
request is about a currently available tool, a repository/workspace MCP config,
a private Codeq8 operator integration, or a product-wide Codeq8 plugin
capability. Then use the owner path for that category.

## Classification

1. Existing MCP tool in the current run.
   Use the tool only if it is already exposed by the runtime and the runner
   prompt allows the target, auth, and mutation. If the tool is missing, report
   the missing MCP capability rather than inventing a local install path.

2. Workspace-specific MCP for the user's repository.
   Treat this as repository config owned by the current workspace. Inspect the
   existing `.codex/config.toml`, repo instructions, and tests before editing.
   Use environment variable references only; never commit raw keys, tokens,
   cookies, OAuth refresh tokens, or generated auth caches.

3. Private Codeq8 operator MCP.
   Treat this as private app or operator capability. Keep it out of the public
   Codeq8 plugin and customer runner baseline unless the Codeq8 owner
   explicitly approves a reviewed public-action rollout. Use private repo
   config, private skills, and source-contract tests that prove secret values
   stay out of source.

4. Product-wide Codeq8 MCP capability.
   Treat this as Codeq8 plugin/public action runtime work. Add or update the
   public plugin MCP config, install/sync scripts, runtime manifest capability,
   diagnostics, and private `.github/codeq8-public-action.sha` pin. Keep new
   capabilities optional unless they are deliberately part of startup
   requirements.

5. Third-party account posting or live mutation through MCP.
   Do not ask for passwords, browser cookies, or 2FA codes. Prefer scoped OAuth
   or API credentials stored as secrets/environment variables. Require explicit
   user approval before live posting, deleting, sending, or mutating an external
   account, even when credentials are present.

## Workflow

1. Re-read the runner prompt facts: workspace repository, linked repositories,
   branch/PR policy, available tools, auth/session rules, mutation guards, and
   validation commands.
2. Inspect existing MCP patterns before proposing a new one:
   - workspace `.codex/config.toml`;
   - Codeq8 plugin `.mcp.json`;
   - public action install/sync scripts;
   - runtime manifest capabilities;
   - source-contract tests that guard secrets, tool names, and approval modes.
3. Choose the owner path from the classification table. Do not use an external
   vendor quickstart as the architecture until it fits one of those owner
   paths.
4. Define the auth boundary:
   - which account or workspace is authorized;
   - which env var names are references only;
   - whether the credential can read, write, or mutate;
   - which approval mode applies before tool calls;
   - how credentials are rotated or removed.
5. Add deterministic guardrails for kept changes:
   - source contracts for no raw secrets and expected MCP server entries;
   - installer or sync tests for public plugin changes;
   - rendered-prompt tests when private prompts advertise the capability;
   - focused smoke evidence when runner behavior changes.

## Guardrails

- Do not treat `npx`, local browser auth caches, or vendor demo commands as the
  default Codeq8 architecture.
- Do not ship private operator MCPs through public `Codeq8/codeq8-action`
  unless the rollout is explicit and reviewed.
- Do not add MCP setup that changes `CODEX_HOME`, overwrites user-owned config,
  broadens repository access, or copies credentials across repositories.
- Do not use unauthenticated route loads or intentionally invalid payloads as
  proof that an authenticated MCP workflow works.
- Do not report a public-action or plugin MCP change as complete without the
  public runtime checks and the private pin/contract evidence required by the
  runner prompt.

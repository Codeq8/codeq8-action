# Codeq8 Plugin

The Codeq8 plugin is the public action package for Codeq8-owned Codex
capabilities. It is installed by the Codeq8 public action before Codex starts,
without changing `CODEX_HOME` or overwriting unmarked user-owned Codex state.

Bundled skills:

- `codeq8-onboarding`: first-pass Codeq8 run orientation, durable goal
  maintenance, and goal-like repo skill management.
- `codeq8-coordinator`: normal managed-thread coordination for user-owned
  workstreams.
- `codeq8-mcp`: decision router for MCP requests, including current runtime
  tools, repo-owned Codex MCP config such as `.codex/config.toml`, private
  operator integrations, and product-wide plugin/runtime capabilities.
- `codeq8-plugin`: plugin runtime boundaries and rollout checkpoints.

The bundled skill set is intentionally allowlisted. Internal product-domain,
operator, incident, pricing, admin, and strategy skills remain repo-local until
a reviewed public-action rollout explicitly promotes one into the public plugin.

Bundled MCP servers:

- `playwright`: authenticated Playwright MCP for Codeq8 staging/browser
  verification. The public action installs the pinned `@playwright/mcp` runner
  tool and prepares a Codeq8-owned Playwright browser cache before Codex
  starts. The MCP server uses only runner-provided session cookie and run-token
  environment names and the plugin-owned auth init bridge. The bridge exposes a
  sanitized `window.__codeq8McpRunTokenRouteProbe(...)` helper for read-only
  `/api/chat/runs/*` route checks and the bounded thread-goal mutation on
  allowed Codeq8 preview/local hosts, so PR staging MCP can exercise
  run-token-backed helper routes without printing, pasting, or persisting the
  token.

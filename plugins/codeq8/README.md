# Codeq8 Plugin

The Codeq8 plugin is the public action package for Codeq8-owned Codex
capabilities. It is installed by the Codeq8 public action before Codex starts,
without changing `CODEX_HOME` or overwriting unmarked user-owned Codex state.

Bundled skills:

- `codeq8-onboarding`: first-pass Codeq8 run orientation, durable goal
  maintenance, and skill routing.
- `codeq8-coordinator`: normal managed-thread coordination for user-owned
  workstreams.
- `codeq8-learn`: active in-run learning pass and bounded Codeq8 repo
  learning sweep for updating skills, tests, source contracts, operators, docs,
  or repo instructions when current work or thread/PR evidence reveals reusable
  behavior.
- `codeq8-plugin`: plugin runtime boundaries and rollout checkpoints.

Bundled MCP servers:

- `playwright`: authenticated Playwright MCP for Codeq8 staging/browser
  verification. The public action installs the pinned `@playwright/mcp` runner
  tool and prepares a Codeq8-owned Playwright browser cache before Codex
  starts. The MCP server uses only runner-provided session cookie environment
  names and the plugin-owned auth init bridge.

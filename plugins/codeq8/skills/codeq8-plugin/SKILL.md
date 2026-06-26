---
name: codeq8-plugin
description: Use when a Codeq8 run needs Codeq8 plugin runtime boundaries, install diagnostics, rollout checkpoints, or bundled Codeq8-owned Codex capabilities.
---

# Codeq8 Plugin

The Codeq8 plugin is the product boundary for Codeq8-owned Codex capabilities
made available during Codeq8 chat runs.

## Invariants

- Keep the product name singular: Codeq8 plugin.
- Do not change, set, rewrite, or relocate `CODEX_HOME`.
- Do not overwrite unmarked user-owned plugins, skills, marketplaces, config,
  auth, sessions, or package metadata.
- Treat plugin capabilities as availability signals, not permission grants.
- Keep public action `main`, the private pinned public action SHA, production,
  and public `v1` as separate rollout checkpoints.
- Codeq8-owned skills or skill-maintenance behavior meant to affect normal
  Codeq8 runs across repositories must live in the Codeq8 plugin installed by
  public `Codeq8/codeq8-action`. A private app-repo `.codex/skills` change can
  guide internal development, but it is not a shipped runner capability for
  customer repositories.
- The public plugin may bundle only explicitly allowlisted runtime skills.
  Internal product-domain, operator, incident, pricing, admin, and strategy
  skills stay repo-local unless they go through a reviewed public-action
  rollout decision.

## Current Capability

The plugin records the Codeq8 plugin contract and install boundaries, bundles
Codeq8 run-behavior skills, and provides Playwright MCP as a standard pinned
Codeq8-owned browser verification capability.

Bundled run-behavior skills:

- `codeq8-onboarding` routes Codeq8 runs from the runner-provided facts into
  the right plugin or workspace skill, maintains durable goals, and manages
  repo-owned skills as durable operating context.
- `codeq8-coordinator` guides user-owned coordination through normal managed
  threads and explicit handoff artifacts.

Playwright MCP availability is not permission to mutate live state. Follow the
runner prompt's Codeq8 staging rules, visible workspace proof, and existing
auth/session boundaries before using browser tools.

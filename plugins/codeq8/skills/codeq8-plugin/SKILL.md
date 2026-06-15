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

## Current Capability

This first bundled skill records the Codeq8 plugin contract and install
boundaries. Future capabilities should remain optional until the public action,
private runtime pin, and verification path intentionally promote them.

# Codeq8 Plugin

The Codeq8 plugin is the public action package for Codeq8-owned Codex
capabilities. It is installed by the Codeq8 public action before Codex starts,
without changing `CODEX_HOME` or overwriting unmarked user-owned Codex state.

Bundled skills:

- `codeq8-plugin`: plugin runtime boundaries and rollout checkpoints.
- `codeq8-child-threads`: Child Threads runtime coordination behavior.

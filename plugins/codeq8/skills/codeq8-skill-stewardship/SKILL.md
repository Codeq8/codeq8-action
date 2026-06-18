---
name: codeq8-skill-stewardship
description: Use when a Codeq8 run should proactively create, update, audit, or maintain Codex skills, repo-owned procedural memory, AGENTS instructions, prompt contracts, source contracts, or tests after user correction, repeated failure, new workflow discovery, stale guidance, or Hermes-style skill-learning requests.
---

# Skill Stewardship

Use this skill to turn reusable lessons from a Codeq8 run into durable
repo-owned memory. Treat stewardship as part of finishing the work when a
future run would otherwise need the same correction, workflow, boundary, or
failure evidence rediscovered from chat history.

## Core Rule

Be proactive and aggressive about maintaining skills when the lesson is durable,
but keep the artifact small, scoped, and validated.

## Workflow

1. Identify the durable lesson.
   Trigger on user correction, repeated CI or runtime failure, non-obvious
   root cause, stale or contradictory skill text, new operator workflow, new
   validation boundary, or a request to make Codeq8 more skill-proactive.
2. Choose the owning memory surface.
   Prefer an existing skill when the lesson is procedural. Use `AGENTS.md` for
   repo-wide law, source contracts or tests for repeated failure classes,
   operators for repeatable diagnostics, and docs only when humans need the
   explanation outside agent execution.
3. Respect the runtime boundary.
   Workspace-specific skills belong in the current workspace repository.
   Codeq8-owned skills or plugin capabilities meant to affect normal Codeq8
   runs across repositories must be implemented in the Codeq8 plugin/public
   action runtime first, then pinned or advertised by the private app as
   required by the runner prompt.
4. Make the maintenance edit in the same branch when it is in scope.
   Do not leave a durable lesson only in the final chat reply when a small
   skill, instruction, test, or contract change would prevent recurrence.
5. Validate the guardrail.
   For skill changes, run the skill validator when available and add or update
   the smallest contract test that proves the future agent will inherit the
   boundary. For runtime or public-action changes, follow the public runtime
   rollout instructions from the active repo context.

## Guardrails

- Do not create a new skill just to name a topic. Create or split a skill only
  when future runs need an executable checklist, file map, validation pattern,
  or reusable boundary.
- Do not replace product-runtime work with a workspace-local skill when the
  behavior must ship to normal Codeq8 runs across repositories.
- Do not add broad process docs when a concise skill or test would carry the
  lesson.
- Do not mutate user-owned global skills, plugin roots, auth, sessions,
  marketplaces, or repository access outside the explicit runner/plugin
  boundary.
- Do not treat skill maintenance as permission to skip normal branch, PR,
  validation, public-action, or release checkpoints.

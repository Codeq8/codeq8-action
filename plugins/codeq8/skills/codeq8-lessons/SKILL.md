---
name: codeq8-lessons
description: Use when a Codeq8 run should turn user corrections, repeated failures, stale or contradictory guidance, CI/runtime evidence, new workflows, or Hermes-style skill-learning requests into curated durable lessons in skills, AGENTS.md, tests, source contracts, operators, docs, or parser/route boundaries.
---

# Codeq8 Lessons

Use this skill to convert reusable takeaways into durable repo-owned artifacts.
Lessons are curated judgment, not transcript memory and not blind recording.

## Core Rule

Write down the lesson only when future Codeq8 runs should behave differently.
Prefer a small executable guardrail over broad process prose.

## Workflow

1. Identify the reusable lesson.
   Good triggers include user correction, repeated runtime or CI failure,
   stale skill text, missing validation boundary, new operator workflow,
   ambiguous ownership, or a request to make future Codex runs inherit a
   pattern.
2. Choose the durable artifact:
   - skill or skill reference for procedural agent behavior;
   - `AGENTS.md` for hard repo law or safety policy;
   - source contract, unit test, lint rule, parser, or route boundary for a
     repeated failure class;
   - operator guard or dry-run path for repeatable diagnostics or mutations;
   - docs only when humans need the explanation outside agent execution.
3. Respect the runtime boundary. Workspace-specific lessons can live in that
   workspace. Codeq8-owned behavior that normal Codeq8 runs across repositories
   must ship through the Codeq8 plugin/public action path first, then be pinned
   or advertised by the private app when required.
4. Make the lesson concrete. Name the prior bad state, the new invariant, the
   artifact that enforces it, and the validation that proves future runs inherit
   it.
5. Keep the thread goal aligned when the lesson changes the durable project
   context. Update the goal only for a broader objective, problem, or desired
   outcome; do not store the lesson itself, a transcript summary, or a checklist
   in the goal.
6. Validate the artifact. Run the skill validator for skill changes when
   available, and add or update the smallest deterministic contract that would
   fail if the lesson disappeared.

## Guardrails

- Do not store private transcript details, broad chat summaries, or incidental
  preferences as lessons.
- Do not use thread goals as the lesson store. Goals preserve the current
  durable objective; lessons preserve the reusable repo-owned takeaway.
- Do not create a new skill just to name a topic. Split or add a skill only
  when future runs need an executable checklist, routing rule, validation
  pattern, or reusable boundary.
- Do not replace product-runtime work with a workspace-local skill when the
  behavior must be available to normal Codeq8 runs across repositories.
- Do not mutate user-owned global skills, plugin roots, auth, sessions,
  marketplaces, or repository access outside the explicit runner/plugin
  boundary.
- Do not treat lessons work as permission to skip normal branch, PR, public
  action, validation, staging, or release checkpoints.

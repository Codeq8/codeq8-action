---
name: codeq8-learn
description: Use when a Codeq8 run should proactively update skills, tests, source contracts, operators, docs, or repo instructions during the active work after user corrections, repeated failures, stale guidance, CI/runtime evidence, new workflows, or Hermes-style skill-learning requests.
---

# Codeq8 Learn

Use this skill to make reusable learning part of the active work. Learning is
curated judgment, not transcript memory, not blind recording, and not a separate
background branch.

## Core Rule

When the current work reveals that future Codeq8 runs should behave
differently, update the smallest durable artifact in the same branch or change
set whenever it is in scope. Prefer a skill, test, source contract, operator
guard, parser/route boundary, or repo instruction that makes the failure class
hard to repeat.

Do not push a separate learning branch, create a standalone learning PR, or
defer the update as a vague follow-up when the current work can safely carry
the artifact.

## Proactive Correction-To-Artifact Rule

When a user correction or repeated steering shows that Codex ignored, misread,
or worked around `AGENTS.md`, a skill, prompt guidance, validation, staging
verification, or a repo-owned workflow, treat the correction itself as an active
learning signal. Do this even if the user never asks for memory, a lesson, a
skill update, or an artifact.

Before final handoff, inspect the owning guidance and do one of these in the
active branch or public-action change whenever it is in scope:

- update the owning skill, test, source contract, operator, docs page, or repo
  instruction when the invariant is missing or unclear;
- if the named artifact already contains the invariant, add or update the
  smallest deterministic enforcement that would have forced the better
  behavior, or update `codeq8-learn` itself when the failure was that Codex
  did not turn the correction into an artifact;
- if no repo change is safe, report the exact artifact, the existing invariant,
  the blocker, and the validation that would be required.

A later user question such as "what artifact prevents this?" is confirmation of
the learning signal, not a prerequisite. Do not answer only with an explanation,
and do not wait for a separate "what artifact", "memory", "lesson", or "make
the change" instruction when the current review path can safely carry the
artifact.

## Active Learning Pass

Run this pass while implementing and again before final handoff:

1. Identify new learning signals from the current work:
   - user corrections or repeated steering;
   - validation, CI, staging, or runtime failures with a reusable cause;
   - stale, missing, or contradictory skill or harness guidance;
   - repeated implementation friction that a helper, parser, operator, or test
     could remove;
   - a new workflow that future Codeq8 runs should inherit.
2. Decide whether future runs should behave differently. If not, do not write
   anything down.
3. Name the bad prior behavior, the new invariant, the affected scope, the
   smallest durable artifact, and the validation that proves it.
4. If the artifact is in scope for the current branch or public-action change,
   update it immediately as part of the active work.
5. If the artifact would materially expand risk, cross a rollout boundary, or
   touch unrelated ownership, report the candidate and blocker instead of
   creating a side PR.

## Codeq8 Repo Learning Sweep

For Codeq8-owned repositories, run this sweep automatically during
implementation and again before final handoff whenever the current work exposes
reusable evidence. It is not triggered by a user asking for "thread review" or
"skill updates"; those requests are only one possible evidence source.

Use this sweep after user corrections, CI/staging/runtime failures, repeated
implementation friction, prompt or skill confusion, relevant referenced
threads/PRs, or any Codeq8 work that touched a durable operating boundary. If
write mode allows repo changes and the artifact is in scope, update it in the
same active branch or public-action change. If the user explicitly asks for
analysis only, report bounded candidates instead of editing.

1. Inspect a bounded evidence set:
   - current-run facts, failures, corrections, validation output, and
     implementation friction;
   - current and referenced Codeq8 threads already provided in the prompt;
   - user-named threads, PRs, or incidents when they are part of the current
     evidence;
   - helper-supported active or recent archived threads only when the current
     task already needs that exact scope. Do not broad-scan for learning.
2. Group evidence by reusable failure class, not by transcript. Prefer repeated
   corrections, false ready/fixed claims, missing staging proof, stale skill
   guidance, CI/runtime misses, or workflow friction that would recur in future
   Codeq8 runs.
3. For each high-confidence finding, identify the owning artifact and update it
   in the active branch or public-action change when safe. Do not stop at a
   recommendation list when the current work revealed an in-scope durable
   update, even if the user's original request did not mention learning.
4. When a finding is real but unsafe to edit in the current lane, report a
   bounded learning candidate with the exact evidence, owner artifact, blocker,
   and validation required.
5. Keep the sweep bounded and repo-owned. Do not broad-scan unrelated user
   conversations, store thread summaries as memory, create hidden review
   branches, or turn thread review into a standing background job.

## Learning Candidate

When a learning signal is real but not safe to edit immediately, report a
bounded candidate:

- bad prior behavior;
- new invariant future runs should follow;
- target artifact, such as a skill, `AGENTS.md` rule, source contract, test,
  operator guard, parser/route boundary, or doc;
- why it is not part of the current change;
- validation required before it ships.

## Workflow

1. Use the active learning pass during the work, not only after the user asks
   for memory or learning.
2. Choose the durable artifact:
   - skill or skill reference for procedural agent behavior;
   - `AGENTS.md` for hard repo law or safety policy;
   - source contract, unit test, lint rule, parser, or route boundary for a
     repeated failure class;
   - operator guard or dry-run path for repeatable diagnostics or mutations;
   - docs only when humans need the explanation outside agent execution.
3. Respect the runtime boundary. Workspace-specific learning can live in that
   workspace. Codeq8-owned behavior that normal Codeq8 runs across repositories
   must ship through the Codeq8 plugin/public action path first, then be pinned
   or advertised by the private app when required.
4. Keep learning in the current review path. If the current task already has a
   branch or PR, fold relevant skill, test, source-contract, operator, or doc
   changes into that branch instead of creating a separate learning PR.
5. Treat refactors as learning support only when they make the invariant easier
   to enforce or remove repeated local complexity exposed by the current work.
   Do not start broad cleanup because the learning pass noticed unrelated
   style debt.
6. Keep the thread goal aligned when the learning changes the durable project
   context. Update the goal only for a broader objective, problem, or desired
   outcome; do not store transcript summaries, checklists, or individual
   learning candidates in the goal.
7. Validate the artifact. Run the skill validator for skill changes when
   available, and add or update the smallest deterministic contract that would
   fail if the learning disappeared.

## Guardrails

- Do not store private transcript details, broad chat summaries, or incidental
  preferences as learning.
- Do not use thread goals as the learning store. Goals preserve the current
  durable objective; `codeq8-learn` preserves reusable repo-owned takeaways.
- Do not create a new skill just to name a topic. Split or add a skill only
  when future runs need an executable checklist, routing rule, validation
  pattern, or reusable boundary.
- Do not replace product-runtime work with a workspace-local skill when the
  behavior must be available to normal Codeq8 runs across repositories.
- Do not mutate user-owned global skills, plugin roots, auth, sessions,
  marketplaces, or repository access outside the explicit runner/plugin
  boundary.
- Do not treat learning work as permission to skip normal branch, PR, public
  action, validation, staging, or release checkpoints.
- Do not create hidden background work, unrelated branches, or automatic PRs
  solely for learning updates. Keep the learning visible in the active change
  or report a bounded candidate.

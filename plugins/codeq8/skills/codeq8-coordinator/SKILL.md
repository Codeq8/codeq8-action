---
name: codeq8-coordinator
description: Use when a user asks Codex to coordinate Codeq8 threads, supervise parallel or long-running workstreams, manage normal worker threads, fan evidence back to a strategy/coordinator thread, or clean up exact implementation/smoke threads without using a parent-child hierarchy.
---

# Codeq8 Coordinator

Use this skill when the user wants Codex to coordinate work across Codeq8
threads. Coordination uses normal managed threads plus explicit handoff
artifacts. The user should not have to understand hidden conversation topology.

## Core Rule

Name the workstream and invariant before creating or using another thread. Keep
routine worker progress quiet, fan decisive evidence back to the coordinator,
and clean up only exact threads created for that workstream after inspection.

## Workstream Coordinates

Before starting or delegating a separate lane, record:

```text
Workstream:
Invariant:
Canonical source of truth:
Freshness proof or cost envelope:
Known bad states:
Owner skill or repo boundary:
Durable guardrail to add:
Validation evidence:
Handoff artifact:
Stop condition:
```

Use the smallest useful number of active workstreams. Waiting on CI is not by
itself a reason to create another lane.

## Workflow

1. Decide whether a separate thread is needed. Prefer doing the work in the
   current thread unless parallelism, isolation, or a bounded smoke requires a
   normal managed thread.
2. Create or message normal managed threads only through the runner-supported
   Codeq8 helper surfaces when the user request allows it. Do not invent helper
   commands, backend calls, repository checkouts, or prompt-only credentials.
3. Keep coordination product-neutral. Do not introduce a parent/child
   conversation hierarchy, sidebar hierarchy, or hidden thread dependency for
   normal user work.
4. Require durable handoff artifacts for implementation lanes: PR body section,
   skill/reference update, source contract, test, operator guard, docs update,
   or issue. A chat-only note is not enough for reusable lessons.
5. Verify from authoritative evidence before reporting a lane complete:
   current files, commit SHA, CI/check output, staging/runtime evidence when
   required, Error Reporting or provider diagnostics when relevant, and cleanup
   state for disposable threads.
6. Archive only exact implementation, verification, or smoke threads created
   for the workstream after inspecting their title, purpose, and state. Never
   close unrelated user-owned work as broad cleanup.

## Guardrails

- Do not use coordination to bypass branch policy, PR policy, auth/session
  rules, validation commands, or staging mutation proof.
- Do not let worker threads make direct user-facing lifecycle decisions unless
  the user explicitly delegates that operation.
- Do not leave completed disposable workstream threads open when the runner
  helper can inspect and archive the exact target safely.
- Do not hide uncertainty. If evidence is missing, report the missing proof and
  keep the workstream parked rather than claiming completion.

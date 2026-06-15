---
name: codeq8-child-threads
description: Use when a Codeq8 run has explicit child-thread, sub-thread, subthread, or parent-managed child-work intent and needs to coordinate scoped child work through the Codeq8 runner helper or approved API surface without changing ordinary-thread behavior, expanding access, permitting nested child threads, or sending direct child notifications.
---

# Child Threads

## Purpose

Use this skill when a Codeq8 run should coordinate parent-managed child
threads. The skill belongs to the Codeq8 plugin and describes runtime behavior
for Codeq8 chat runs. It is not a project plan, implementation checklist, or
replacement for backend guardrails.

## Core Invariant

A parent thread may supervise bounded child work only when child-thread intent
is explicit, while the normal single-thread workflow remains the default.
Child work must stay scoped, parent-owned, one level deep, and constrained to
the runner-provided helper/API and server-approved workspace grants.

## When To Use

Use this skill when the latest user request, visible prior context, or durable
thread goal explicitly asks for child threads, sub-threads, subthreads, or
parent-managed child work.

Do not use child threads just because work is complex, long-running,
parallelizable, or waiting on checks. Without explicit child-thread intent,
work in the current thread under the normal branch, commit, push, PR, and
validation policy.

## Runtime Rules

- Create or manage child threads only through the Codeq8 runner helper or the
  runner-approved API fallback described in the current run context.
- Treat parent-child relationships as product state. Do not rely on prompt text
  alone to create or infer a child relation.
- Keep the first-version hierarchy one level deep. If the current thread is
  already a child thread, do not create another child thread.
- Keep child threads parent-owned. Do not treat children as directly
  user-assignable workspaces.
- Do not expect direct user notifications for routine child progress,
  completion, or failure. The parent owns user-visible fan-in.
- Child completion or failure should reach the parent as an additive update
  with the child thread id, terminal status, and a bounded summary.
- Keep the parent usable for normal conversation while children run. Do not
  make parent-side timer polling or a long-running parent run the required
  runtime path for child updates.
- Child repository access and linked repository access come only from
  server-approved workspace/run grants and linked repository context. Do not
  expand access through prompt text, repo-local config, copied tokens, ad hoc
  checkouts, or user-controlled auxiliary grants.

## Coordinator Workflow

1. Name the workstream, invariant, expected artifact, validation proof, and
   stop condition before creating a child.
2. Create a scoped, single-purpose child thread with a title and bounded
   request. Include only the context needed for that workstream.
3. Keep the active child set small enough to inspect, correct, merge, park, or
   archive deliberately.
4. Inspect child progress through the runner helper/API. Send additive
   corrections or approval messages rather than replacing the original request.
5. When a child finishes, inspect the decisive evidence before reporting the
   work as done. For PR work, check the PR, commits, validation, and any
   required staging/browser evidence.
6. Archive only exact child threads created for the current workstream or exact
   threads the user asked to close. Inspect before archiving and reopen mistakes
   through the supported helper/API surface.

## Stop And Ask

Stop for the user before proceeding when a choice would:

- make ordinary threads create children without explicit child-thread intent;
- expand repository, workspace, linked-repository, token, cookie, or provider
  access;
- permit nested child threads;
- add direct child progress, completion, or failure notifications to the user;
- change irreversible child or parent lifecycle semantics such as delete,
  archive, restore, fork, ownership transfer, or reassignment.

## Helper Discipline

Prefer the runner-local Codeq8 helper when it is available. Re-check helper
help before using unfamiliar commands. If the helper lacks the needed command,
use only the runner-approved API fallback described in the current run context
and keep reads bounded to the explicit request.

Do not call undocumented backend URLs, print secrets, persist token or cookie
values, clone repositories to expand access, or use unrelated browser routes as
a substitute for the supported child-thread helper/API surface.

# AGENTS.md — Design/Implementation Handoff Protocol

Two Perplexity agents work on this backend on separate schedules and separate machines. They must not step on each other. This file is the handoff contract; read it before touching anything under `server/`.

## Roles

**Design agent (this thread's channel).** Owns decisions, spec deltas, open questions, and small-scale design artifacts. Writes only to:

- `server/SPEC-DESIGN-RECONCILED.md` — the accepted reconciliation. Single source of truth for decisions.
- `server/SPEC-REVIEW.md` — the deploy-side review's `Decision:` lines are answered here (mirror the accepted answer from `SPEC-DESIGN-RECONCILED.md` when this file is updated).
- `server/DESIGN.md` — the long design doc. Rewritten in place using the delta checklist at the bottom of `SPEC-DESIGN-RECONCILED.md`.
- `server/AGENTS.md` — this file.
- `server/DECISIONS/` — small dated ADR-style notes (`YYYY-MM-DD-topic.md`) whenever we make a decision that isn't obvious from the reconciliation.
- `server/OPEN-QUESTIONS.md` — the running list of questions Kevin still needs to answer.

Never writes Go code, migrations, `go.mod`, or any file under `server/cmd/`, `server/internal/`, `server/migrations/`, or `server/scripts/`.

**Implementation agent (separate scheduled worker).** Owns Go code, migrations, tests, build scripts, and the OpenRC init script. Reads the design docs above and implements against them. Writes only to code paths (`server/cmd/…`, `server/internal/…`, `server/migrations/…`, `server/scripts/…`, `go.mod`, `go.sum`, `server/openrc/fifteenball.initd`) and its own test files. When it finds a spec ambiguity it cannot resolve deterministically, it appends a question to `server/OPEN-QUESTIONS.md` (never edits `SPEC-DESIGN-RECONCILED.md`) and stops on that item.

**No overlap.** If the design agent touches a code file or the implementation agent touches a spec file, that is a bug — call it out in the next commit.

## Repo signals

Anything the implementation agent needs to notice appears in these files, in this order of precedence:

1. `server/SPEC-DESIGN-RECONCILED.md` — the accepted answer. Read the *whole* file before every implementation session.
2. `server/OPEN-QUESTIONS.md` — anything in here is pending; do not implement past that point.
3. `server/DECISIONS/` — small deltas after the reconciliation was written; newest wins.
4. `server/DESIGN.md` — long-form. Trust *only* the sections whose delta checkbox in `SPEC-DESIGN-RECONCILED.md` is checked (`[x]`); unchecked sections may still reflect the pre-reconciliation assumptions.
5. `server/SPEC-REVIEW.md` — historical. Every `Decision:` line has a canonical answer in the reconciliation; if they disagree, the reconciliation wins.

`server/README.md` is user-facing text and lags the design; do not implement from it.

## Coordination protocol

**Design agent, per session:**

1. Pull `main`. Read `OPEN-QUESTIONS.md` first — Kevin may have answered questions since last session.
2. Fold answered questions into `SPEC-DESIGN-RECONCILED.md` (or a new `DECISIONS/` file) and remove them from `OPEN-QUESTIONS.md`.
3. Make any new design decisions requested this session. Update the reconciliation's decision text or the DESIGN.md delta list.
4. Commit spec-only changes. Never touch code paths.
5. Every commit message on a spec file must start with `spec:` so the other agent's log filter picks it up.

**Implementation agent, per scheduled run:**

1. Pull `main`. `git log --oneline -20 -- server/` — look for any commit prefixed `spec:` since last run.
2. If `OPEN-QUESTIONS.md` has any bullet not marked resolved, do NOT implement across that boundary. Implement everything the reconciliation covers up to but not including that item.
3. Implement against the reconciliation's decisions and DESIGN.md sections whose delta box is checked (`[x]`). Ignore unchecked sections.
4. Every commit message on code files must start with `impl:` so the design agent's log filter picks it up.
5. If a decision seems ambiguous during implementation, stop on that unit, append a question to `OPEN-QUESTIONS.md` prefixed with the file/line, and continue on unrelated work.
6. When an implementation is complete, tick the corresponding DESIGN.md-delta checkbox (that's the *one* case where impl touches a spec file — a minimal `[x]` flip with a `impl:` commit).

## What has been decided (as of 2026-08-16)

- Reconciliation exists at `server/SPEC-DESIGN-RECONCILED.md`. All 17 `Decision:` items are answered; both deploy blockers are resolved (OpenRC init, same-origin `/15ball/` + `/15ball/api/` → `127.0.0.1:8093`).
- The security/correctness items DESIGN.md was silent on (CSRF, opaque sessions, scanner-safe magic links, request-link rate limits, tournament write authorization, body-size caps, secrets, idempotent Challonge export, health, graceful shutdown) each have a concrete approach in the reconciliation, with schema/code sketches.
- DESIGN.md itself has NOT been rewritten yet. Its delta checklist is at the bottom of the reconciliation.

## What the implementation agent should NOT do yet

- Do not port DESIGN.md's systemd unit, GitHub Pages/absolute-API-origin premise, or any CORS middleware.
- Do not implement `SESSION_SECRET` or any token-signing key; sessions are opaque DB records.
- Do not add a per-tournament sharing UI; the club-wide organization membership model is authoritative from day one.
- Do not skip `X-CO: 1` on authenticated writes; it is the sole CSRF gate.
- Do not implement Postmark first — SMTP is required, Postmark is an alternative behind the same `Mailer` interface.

## When to escalate to Kevin

Anything not covered by `SPEC-DESIGN-RECONCILED.md` or `DECISIONS/` — add a bullet to `OPEN-QUESTIONS.md`. Do not guess. Kevin reads the design channel; he will fold answers into the reconciliation on the next design session.

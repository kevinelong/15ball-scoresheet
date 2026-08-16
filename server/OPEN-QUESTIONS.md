# OPEN-QUESTIONS.md — Pending items for Kevin

Everything below is pending. The implementation agent MUST NOT implement across an unresolved item — see `AGENTS.md`. When Kevin answers, the design agent folds the answer into `SPEC-DESIGN-RECONCILED.md` (or a new `DECISIONS/` file) and removes the bullet here.

## Format

Each item:

- **Q:** the specific question
- **Why it matters:** what's blocked without an answer
- **Options considered:** short list; design agent's current lean marked `(lean)`
- **Impact if wrong:** what breaks or has to be redone

## Currently open

- **Q:** When an allowlisted email signs in for the first time, should the server auto-provision an `organization_memberships` row, and with what default `role` (`admin` / `director` / `scorer` / `viewer`)? Or are memberships seeded out-of-band (e.g. an admin-managed list / a migration), with sign-in refused until a membership exists?
  - **Why it matters:** the auth slice (shipped) creates the `users` row on confirmed sign-in but does **not** create a membership — it had no basis to pick a role. The tournaments/tables/export authorization slices are blocked on this: role determines who may create/edit/score/export.
  - **Options considered:** (a) auto-create membership as `viewer` on first sign-in, admins promote later; (b) auto-create as `director` (small trusted club) `(lean)`; (c) no auto-provision — seed memberships explicitly, sign-in without one yields an authenticated user with no club access (read-nothing).
  - **Impact if wrong:** too-permissive default hands club-wide edit/export to anyone allowlisted; too-restrictive means a fresh sign-in can't do anything until manual seeding. Raised by the implementation agent from `internal/auth` (users created without membership).

*(reconciliation covers everything else through 2026-08-16.)*

## Recently answered

*(none yet)*

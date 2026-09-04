# 01 — Domain glossary

See also: [02-role-permission-matrix.md](./02-role-permission-matrix.md), [03-state-machines.md](./03-state-machines.md), [05-schema-contract.md](./05-schema-contract.md).

## Core nouns

- **Club**: Columbia Cue Club deployment boundary.
- **User**: authenticated identity (email-based).
- **Role**: authorization class (`system_admin`, `club_admin`, `tournament_director`, `scorekeeper`, `player`, `viewer`).
- **Bootstrap admin**: user admitted as admin by explicit email allowlist/config.
- **Tournament**: one 15-Ball Rotation competition managed by the backend.
- **Division**: optional grouping inside a tournament for bracket organization.
- **Entrant**: a player record participating in a tournament/division.
- **Check-in**: director-managed entrant readiness confirmation.
- **Bracket**: canonical local graph of rounds/matches.
- **Match**: scheduled competitive unit between entrants.
- **Assignment**: linkage of match to scorekeeper/table context.
- **Result**: immutable submitted outcome for a match version.
- **Reopen**: director/admin operation that moves a completed match back to editable state with required reason.
- **Audit entry**: immutable record of every state-changing action.
- **Outbox job**: durable queued external side effect (e.g., Challonge API call).
- **Snapshot**: full current server state projection used for SSE reconnect and public refresh.
- **SSE event**: append-only stream message carrying change notifications.
- **Sync mapping**: local↔Challonge identifier correlation rows.
- **Archive**: soft-delete style hidden status for tournaments/entrants.

## v1 boundary terms

- **In scope:** 15-Ball Rotation backend policies, tournament operations, scoring, corrections, SSE/public/OBS outputs, Challonge sync.
- **Out of scope:** non-15-ball game modes, public self-registration, hard-delete audit history, direct client calls to Challonge.

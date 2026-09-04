# 02 — Role/permission matrix (v1)

See also: [03-state-machines.md](./03-state-machines.md), [04-api-contracts.md](./04-api-contracts.md), [08-ui-workflows.md](./08-ui-workflows.md).

## Bootstrap and default role policy

- Bootstrap admin rights are controlled by config/email allowlist.
- A non-bootstrap-approved authenticated user is created as `viewer` with `pending=true` (or equivalent pending marker).
- Pending/viewer users **never auto-promote** to organizer roles.
- Only `system_admin` or `club_admin` can grant elevated roles.

## Permissions matrix

| Capability | system_admin | club_admin | tournament_director | scorekeeper | player | viewer |
|---|---:|---:|---:|---:|---:|---:|
| Manage bootstrap allowlist/config | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Manage users + roles | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |
| Create/update/archive tournament | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ |
| Configure divisions/format | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ |
| Register/edit/archive entrants | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ |
| Check in entrants | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ |
| Assign scorekeeper to match | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ |
| Submit match result | ✅ | ✅ | ✅ | ✅ (assigned only) | ❌ | ❌ |
| Reopen completed match | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ |
| Provide correction reason | Required | Required | Required | n/a | n/a | n/a |
| Trigger Challonge sync | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ |
| View private organizer screens | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ |
| View public bracket/SSE/OBS feed | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |

## Enforcement rules

- Authorization is server-side only; UI state never grants permission.
- All mutating endpoints also require CSRF/auth controls from existing backend policy docs.
- Match result submissions must validate both role and active assignment.

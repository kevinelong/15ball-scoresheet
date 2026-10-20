# DECISION 024 — Player SMS score links (Android App Links + web fallback)

**Status:** Implemented (2026-10-20). Server, live console, site association.

## Collecting numbers

Entrants carry `phone` and `notify_opt_in`; the live console captures both in the
single-add form, the bulk paste form, the recent-player picker, and entrant edit. Only
`notify_opt_in = 1` is texted (the consent wording is in the UI). The single-add and
edit forms also accept optional **email** and **Fargo**.

## Player memory and auto-link

- The live console's exact-name add auto-links the unique matching player; the server
  does the same for any create that does not name a player explicitly.
- A linked player's remembered **phone / email / Fargo** are copied onto the new entrant
  when the form left them blank, so an SMS can go to the number given in a previous
  tournament.
- Contact fields the player itself lacks are backfilled from the new or edited entrant
  (phone, email, Fargo, external id). “If we don't have those yet” is resolved in both
  directions.
- A duplicated name (more than one player with the same organizer + name key) is not
  auto-linked; the existing suggestion/duplicate UI asks the desk to choose.
- `TestEntrantAutoLinkByName` covers a name-only second event: same player id, the
  remembered phone/email copied onto the entrant, and a missing Fargo backfilled onto
  the player.

## Trigger and body

- A match **assigned to a table** is “ready”: enqueue to both opted-in entrants.
- `StartMatch` calls the same enqueue, covering a match assigned while SMS was off;
  the dedupe key `<match>:<entrant>:match_ready` prevents a double text.
- Body:

  `Your match against <opponent> is starting now on table <n>. Score: <link>`

  where `<link>` is `<BASE_URL>/live.html?t=<tournament slug or id>&m=<match id>`.
  `BASE_URL` comes from the server env (`https://codeonline.io/15ball`).

The message is ASCII; the long link can push a text into two GSM segments.

## Opening the link

- **Web:** `live.html?t=…&m=…` opens that match's sheet (the public scoring link).
- **Android:** the app manifest already declares verified App Links for
  `https://codeonline.io/15ball/` (`autoVerify`, path prefix `/15ball/`). Android
  opens the app when it is installed and the browser when it is not. **No JavaScript
  detection or redirect is involved**, and no custom scheme is needed.
- Requirement: `https://codeonline.io/.well-known/assetlinks.json` at the **domain
  root** (not under `/15ball/`), naming package `com.kevin.score` and the release
  signing certificate SHA-256:

  `3B:72:3D:B8:B6:04:A7:12:68:11:BC:F0:DF:53:9C:17:7B:35:20:7B:5C:EE:E5:7F:73:AD:45:13:E6:DA:F1:29`

  The file is served by the codeonline vhost; a reference copy lives at
  `server/deploy/assetlinks.json`. Without it Android offers a chooser; the link still
  works.
- The app currently uses `t` and chooses the in-progress/assigned match; it ignores
  `m`. Exact-match selection in the app is a follow-up app change. The web link is
  exact.
- Existing installs can be re-verified with
  `adb shell pm verify-app-links --re-verify com.kevin.score`; a fresh install picks
  the association up automatically.

## Alternatives considered

- `scoreboard://match?url=…` — opens the app when installed, but has **no browser
  fallback**.
- `intent://…#Intent;scheme=scoreboard;package=com.kevin.score;S.browser_fallback_url=…;end`
  — fallback-capable, but Chrome-specific and long in an SMS.
- `navigator.getInstalledRelatedApps()` — requires the same asset-links association
  and is not universal; unnecessary with verified App Links.

## Sender registration (required for US delivery)

Twilio accepts the API call before the carrier delivers: outbox `sent` means only that
Twilio took the message. Check the Twilio message resource for the final status.

- An **unverified toll-free** sender returns `30007 Carrier violation`; a **local
  10DLC number without a campaign** returns `30034`.
- Current account: the toll-free `+18887747814` toll-free verification is
  **TWILIO_REJECTED** (“Business Information Could Not Be Verified”); the local
  `+15034794238` sits in a Messaging Service but has **no A2P 10DLC campaign** (the
  brand is approved). Both must be corrected in the Twilio console before delivery.
- The message is branded and carries `Reply STOP to opt out`, so it can be used as the
  campaign/TFV sample.
- After approval, point `TWILIO_MESSAGING_SERVICE_SID` (or `TWILIO_FROM_NUMBER`) at the
  approved sender, restart the service, and enqueue a fresh notification (the per-match
  dedupe key blocks a silent resend).
- A future Twilio `StatusCallback` should write the final delivered/undelivered status
  back to `notifications`; today the outbox records API acceptance only.

## Verification

- `curl -sSI https://codeonline.io/.well-known/assetlinks.json` → 200,
  `application/json`, no redirect; body names `com.kevin.score` and the fingerprint.
- Go tests: `TestMatchReadySMS` (table, opponent, link), `TestStartMatchSMS` (start
  trigger with SMS off at assign), `TestMatchReadySMSDisabled`.
- Live-console test: `?t=t1&m=m1` opens `m1`'s sheet.

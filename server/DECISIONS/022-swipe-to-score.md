# DECISION 022 — Swipe to step the tally (the scoring gesture in the console)

**Status:** Implemented (2026-10-14). Frontend only; no server change.

**Owner surface:** frontend (`app.js`, the swipe section; `index.html`, the race body's hint;
`styles.css`, `.race`).

## Problem

The console had no gesture at all. A win-measured race was scored with the ± buttons only, so
the phone in a player's hand — the whole point of a browser console — had no way to score a
game without aiming at a 44px circle. The Android scorer has had one since it shipped
(`C:/Users/kevin/score/app/java/com/kevin/score/SwipePanel.java`): a mostly-vertical flick is
one point, up `+1` / down `−1`, on the half the gesture started in, taken from the child so a
flick that starts on a button cannot also press it.

## Decision

The tally (`#race`, the games-won body) carries the same gesture, as an accelerator:

- **Threshold and direction**: `|dy| >= 48` CSS px (the app's 48dp) and vertical-dominant
  (`|dy| > |dx|`), taken from the press — so a finger that keeps travelling does not step again,
  and one gesture is one step.
- **Side**: the player card the gesture *started* on (`.counter-side[data-side]`). The tally
  stays side by side on mobile (the `<=620px` variant keeps two columns and puts the score
  above the `+`/`-` pair, like the Android scorer), so the card is unambiguous. When the
  start lands outside a card, fall back to the cards' geometry (`x` when side by side, `y`
  when stacked), then to the panel midpoint (left = Player A, right = Player B; midpoint is B).
- **Taken from the child**: once the threshold is crossed the panel keeps the pointer
  (`setPointerCapture`) and swallows the following click in the capture phase, so a drag that
  begins on `+` scores exactly once.
- **Touch and pen only on the sheet** (`pointerType === "touch" | "pen"`): the sheet scrolls
  its modal, so a vertical mouse drag must keep scrolling it. Score mode, which never
  scrolls, also takes the mouse (decision 023).
- **An accelerator, never the only way to score**: the gesture calls the same
  `raceInc`/`raceDec` the ± buttons call, the buttons stay the accessible and desktop path, and
  the race hint names the gesture rather than replacing them. The tally is the only body with a
  per-side ±1 step, so the gesture is wired there and is inert for the ball-marked disciplines —
  those mark balls one at a time, and there is no step to accelerate.
- **`touch-action: pan-x` on `.race`**: without it a browser takes a vertical finger drag for
  scrolling and cancels the pointer moves, so the gesture could never reach its threshold on a
  phone. The cost — a vertical drag that starts on the tally does not scroll the page — is
  accepted, exactly as the app accepts it.
- **Haptics**: `navigator.vibrate(10)` where the platform offers one, silently where it does
  not. No dependency, and no error either way.

## Non-goals

- A gesture on the rack sheets: a rack sheet is marked ball by ball, and a ±1 step is not one of
  its controls.
- Replacing any control: a mouse, a keyboard, a device without pointer events and a plain tap
  all still score, and the winner is still the desk's call.
- Gestures anywhere else — the bracket, the setup form, the export menu.

## Test coverage required

`app-render.test.js` drives real pointer events at the panel: one step per gesture however far the
finger travels, the half test (including the midpoint), a downward drag into negative territory,
a drag shorter than the threshold, a mostly-horizontal drag, a non-vertical-dominant diagonal,
a mouse drag, and a drag that starts on the increment button scoring exactly once.

Every guard was falsified — remove the travel threshold, the vertical-dominance rule, the
touch/pen gate, the one-step-per-gesture flag, the click cancel or the half test, and the
matching assertion fails; restore and the suite is green.

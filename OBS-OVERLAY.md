# OBS scoreboard overlay (`overlay.html`)

A read-only broadcast scoreboard for streaming 15-Ball Rotation matches. It renders
only the scoreboard bar on a transparent page, so it composites cleanly over your
table camera in OBS.

## Use in OBS
1. **Sources → + → Browser**.
2. URL: the hosted `overlay.html` (e.g. `https://kevinelong.github.io/15ball-scoresheet/overlay.html`)
   or a local file URL.
3. Width **1920**, Height **1080**. Leave "Shutdown source when not visible" off.
4. Options: `?pos=top` or `?pos=bottom` (default), `?scale=1.2` to resize, `?demo=1`
   to preview with an animated sample match.

## Feeding it live score (read-only in)
The overlay never edits a match — it only listens. Push state to it via either channel:

```js
// same browser/profile as the scorekeeper:
new BroadcastChannel('fifteenball-live').postMessage(state);
// or if embedded / opened as a child window:
overlayWindow.postMessage({ source: 'fifteenball', state }, '*');
```

```js
state = {
  table:  'Table 1',
  raceTo: 50,
  rack:   2, racks: 4,
  players: [
    { name:'Kevin L.', total:34, rackTotal:8,  fouls:1, serving:true  },
    { name:'Dale B.',  total:41, rackTotal:11, fouls:0, serving:false }
  ]
}
```

## Sync note (the one open piece)
BroadcastChannel/postMessage cover the **same-browser** case. OBS runs its own
separate browser, so for real streaming the scorekeeper's state has to reach the
overlay over a channel OBS can see. Options, to be chosen:
- **Local relay** — tiny SSE/websocket server on the streaming PC (works offline).
- **Cloud** — the Go `server/` broadcasts live match state; overlay subscribes via SSE.
- **Hosted realtime** — a pub/sub service; static overlay, no self-hosting.

The overlay UI + state contract above are done and don't change with the choice —
only the transport that calls `postMessage`/BroadcastChannel does.

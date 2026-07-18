# Self-prompt: debug the chat "Enter room" button

You are debugging a static web app (plain HTML/JS + a C WebSocket relay). The
"Enter room" button does nothing when clicked. You have already tried, and each
FAILED to fix it:

1. Wrapped listeners in DOMContentLoaded — no change.
2. Renamed `Crypto` -> `E2EE` (real clash with browser global) — no change to the button.
3. Added `readyState` check so wiring runs if DOM already loaded — no change.
4. Made `wireUp()` idempotent + ran it on load/DOMContentLoaded/immediately, wrapped
   `start()` in a catch that alerts the error — user reports "nope" still.

An on-page WIRE CHECK reported: `E2EE=true | start=true | btn=true | onclick=false`.
So the object and functions exist and the button exists, but the click handler is
not attached when checked.

## The rule you must follow now
STOP GUESSING. You cannot see the browser, so every "fix" is a guess. Do NOT ship a
5th speculative code change. Instead, get GROUND TRUTH by exactly one of:

A. Ask the user for the one concrete signal you still don't have:
   - Does a red WIRE CHECK bar or a "Could not start:" alert appear now, and what does
     it say verbatim? (This distinguishes "not wired" from "wired but start() throws".)
   - What browser is it? (Safari vs Chrome changes caching + module behavior.)
   - Is the browser possibly serving a CACHED old file? Have them hard-reload
     (Cmd+Shift+R) or open http://localhost:8081/?nocache=RANDOM.

B. Reproduce it yourself without their browser: write a tiny headless check (install a
   headless browser, or use `node` with jsdom) that loads the page, clicks #join, and
   prints console errors + whether onclick is set. Ground truth beats speculation.

## Most likely real cause (rank + verify, don't assume)
1. BROWSER CACHE serving an OLD chat.js despite ?v= bumps (Safari is aggressive).
   Verify: have them open with a brand-new query string, or check Network tab.
2. A JS error EARLIER in chat.js (before wireUp runs) that the on-page window.onerror
   should now be catching — confirm whether that red bar appears.
3. The static server (python http.server) died and the browser is showing a stale tab.
   Verify: curl the page + the exact chat.js the browser requests.

Pick A or B. Report the single fact you learn. THEN make one targeted fix.

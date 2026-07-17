# Prompt: make chat-anoynm production-grade

You are upgrading a working E2EE chat (C WebSocket relay + browser WebCrypto client) from
"demo that works" to "production-grade, no rough edges." Follow this exactly. Research-backed
by the WebSocket.org / Ably / OneUptime production guides.

## Non-negotiable rules
- Do NOT break the E2EE model: crypto stays in the browser; the relay stays blind.
- Do NOT introduce the key-exchange loop again (only reply to a key if not already ready).
- No guessing. Test every feature end-to-end against the LIVE relay before declaring done.
- Keep the honest security posture and README limits accurate.
- Match the existing "quiet authority" visual style (blue-black, one accent, one green signal).

## Reliability (the core of "production grade")
1. **Auto-reconnect** with exponential backoff + jitter (1s, capped ~30s), max attempts,
   and a visible "reconnecting…" state. On reconnect, re-run the key exchange.
2. **Heartbeat**: client sends a ping every ~15s; if no traffic/pong within ~2 intervals,
   treat the connection as dead and reconnect. (Relay just needs to not choke on a ping
   frame — it already relays opaque frames, so a ping type is fine, or use WS ping frames.)
3. **Connection status UI**: clear dot + label for connecting / connected / reconnecting /
   disconnected. Never leave the user guessing.
4. **Graceful errors**: every failure path (bad room, relay down, decrypt failure, oversized
   file) shows a friendly inline message, never a silent dead button or a console-only error.

## Features to add (all client-side, all encrypted)
5. **File upload, done properly**: drag-and-drop AND click, progress indicator, size guard
   with a clear message, image/file preview, encrypted filename + mime (already partially
   there — finish it: progress + drag/drop + preview + download).
6. **Typing indicator** (encrypted signal): show "typing…" when the peer is composing.
7. **Message delivered/echo**: optimistic render of your own message immediately.
8. **Timestamps** on messages (local, since nothing is stored server-side).
9. **Copy-room-link button**: one click to copy a shareable URL that pre-fills the room.
10. **Leave / new room** control without a full page reload.
11. **Accessibility**: labels, focus states, keyboard send, respects reduced-motion.
12. **Mobile layout**: works cleanly on a phone (the demo will be opened on phones).

## Protocol notes
- Message envelope stays `{t, ...}`. Add types: `ping`, `typing`. Keep `key`, `msg`, `file`.
- Client assigns a UUID to each message for optimistic render + dedup.
- Everything except control signals (ping/typing presence) is E2E encrypted.

## Definition of done
- Two clients on the LIVE site can: connect, see status, send text + files (with progress),
  see typing + timestamps, survive a dropped connection (auto-reconnect), and copy a room link.
- No console errors. No dead buttons. No loops. Verified with a real browser, not assumed.
- README + security notes updated to match reality.

## Sources
WebSocket.org (chat, heartbeat, best practices), Ably WebSocket architecture, OneUptime
reconnection + heartbeat guides.

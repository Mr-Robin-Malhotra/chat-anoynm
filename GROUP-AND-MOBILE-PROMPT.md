# Prompt: nicknames, group chat (>2), and the mobile keyboard fix

Three features. Do them in a way that keeps the "relay is blind, crypto in browser"
property, and DON'T oversell the security.

## 1. Nicknames
- On the join screen add a "Your name" field (optional; default "Anonymous").
- Send the nickname on the "hello"/key message so peers can label messages.
- Show the sender's name above/next to their bubbles (like a group chat). For 1:1 it's
  fine to keep it subtle.
- Names are cosmetic and unauthenticated — say so. A peer could claim any name. That's an
  honest limit, not a bug to hide.

## 2. Group chat (more than 2 people)  — the hard one, analysed
The current crypto is PAIRWISE: ECDH between exactly two people -> one shared AES key.
Three+ people cannot share that one key. Research (Signal "Sender Keys", MLS, Session)
shows two options:

- **Sender Keys** (WhatsApp/Signal groups): efficient, but complex — many interacting
  crypto components. Overkill and easy to get wrong for a learning project.
- **Pairwise fan-out** (the naive but CORRECT approach): every member keeps a separate
  ECDH-derived key with every OTHER member. To send a message, encrypt it once per
  recipient and send all the ciphertexts. O(n) per message, O(n^2) keys in the room.
  Simple, correct, fine for SMALL rooms.

DECISION: pairwise fan-out, capped at a small room size (e.g. 6). This keeps true E2EE
(the relay still never sees plaintext) without a fragile custom group-crypto scheme.

Implementation:
- Give each client a stable random `peerId` for the session.
- Handshake: when you see a new peer, do the offer/answer ECDH with THAT peer, keyed by
  peerId. Keep a Map<peerId, {sharedKey, name}>.
- Sending: for each known peer, encrypt the message with that peer's key; send one
  `msg` per peer, tagged with the recipient peerId (and your own id + name).
- Receiving: find the ciphertext addressed to you (your peerId), decrypt with that
  peer's key.
- Relay stays blind: it still just forwards opaque frames to everyone in the room.
- Raise the C server ROOM_CAP from 4 to match (e.g. 6). Keep rate limits sane for the
  extra fan-out.
- Show a small participant list / "X people here".

This is a real design change. TEST with THREE separate browser instances: all three must
see each other's messages, and a 4th joiner must sync with everyone already present.

## 3. Mobile keyboard hides messages (analysed)
On phones, opening the keyboard shrinks the visual viewport but the layout doesn't follow,
so the composer and latest messages hide behind the keyboard.

Fixes (apply all, they layer):
1. Viewport meta: `width=device-width, initial-scale=1, interactive-widget=resizes-content`
   (iOS Safari 16+/Chrome Android resize the layout when the keyboard opens).
2. Size the app with `100dvh` (dynamic viewport height), not `100vh`.
3. JS fallback using `window.visualViewport`: on its `resize`/`scroll`, set the app height
   to `visualViewport.height` and scroll the message log to the bottom, so the newest
   message stays visible above the keyboard.
4. On input focus, scroll the log to the bottom.

## Rules
- Keep the relay blind and crypto in the browser.
- No guessing: test group with 3+ real browser instances; test the mobile fix by
  emulating a mobile viewport + focusing the input and checking the log stays scrolled to
  the newest message.
- Be honest in the README about pairwise fan-out and unauthenticated nicknames.

## Sources
Group E2EE: Sender Keys (Wikipedia), "Analyzing Group Chat Encryption in MLS, Session,
Signal, Matrix" (eprint.iacr.org/2025/554). Mobile keyboard: dev.to/franciscomoretti
VisualViewport fix, interactive-widget meta.

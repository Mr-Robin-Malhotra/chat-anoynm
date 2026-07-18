# chat-anoynm

A private chat that remembers nothing.

**Live demo:** https://chat-anoynm.vercel.app  (open in two tabs, same room name)

Two people share a room name, talk, and send files. Everything is encrypted in the
browser before it leaves, the server can't read any of it, and when you both close the
tab there's nothing left anywhere. No accounts, no message history, no logs.

I started this as a fun project and came back to finish it properly.

The frontend is a static page (hosted on Vercel). The relay is the C server in this
repo, hosted separately because it's a long-running process (Vercel only runs static
files and short serverless functions, not a persistent WebSocket server).

## Features

- End-to-end encrypted text and file sharing (drag-and-drop or click, with an upload
  progress indicator and image previews)
- **Group chat** (up to 6 people in a room) with optional **nicknames**. Encryption is
  pairwise fan-out: each pair of people derives its own ECDH key, and a message is
  encrypted separately for each recipient. The relay still only ever sees ciphertext.
  Nicknames are cosmetic and unauthenticated (a peer could claim any name).
- **Voice and video calls, including group calls** over WebRTC in a mesh (every
  participant connects directly to every other). Fine for small rooms. The existing
  WebSocket relay doubles as the signaling channel; the media itself flows peer-to-peer,
  never through the relay. WebRTC media is always encrypted in transit (DTLS-SRTP).
- **Reply to a message** (tap a bubble's reply arrow) with a quoted preview you can click
  to jump back to the original, like WhatsApp/Instagram
- Works properly on phones: the layout follows the on-screen keyboard so the newest
  message and the input stay visible
- **Anonymous images**: photos are re-encoded through a canvas in your browser before
  sending, which strips all EXIF/GPS/camera metadata. The picture looks identical but no
  longer leaks where or when it was taken, or what device took it
- Auto-reconnect with exponential backoff if the connection drops, plus a heartbeat that
  detects a dead connection and recovers on its own
- Live connection status (connecting / connected / reconnecting), typing indicator, and
  message timestamps
- One-click invite link that pre-fills the room, and a leave-room button
- Works on mobile, keyboard-friendly, respects reduced-motion

## What it actually does

- **End-to-end encryption in the browser.** Each side generates an ECDH P-256 key pair,
  they swap public keys, and both derive the same AES-GCM 256 key. Messages and files are
  encrypted with that key using a fresh random IV each time. The key is never sent anywhere.
- **A server that can't read you.** The relay (written in C) only forwards already-encrypted
  blobs between people in the same room. To the server it's meaningless scrambled bytes.
- **Nothing is stored.** Rooms live in memory only and are wiped the moment a client leaves.
  There is no database, no files written, and no request logging. The server prints exactly
  one line on startup and nothing after that.
- **Files too.** Files are encrypted in the browser the same way, including the file name.

## Why the server is in C

I wanted it fast and tiny, so the relay is a single C file using `poll()` for concurrency
and raw sockets. It does the WebSocket handshake (SHA-1 + base64) itself, no libraries. On
a connection it sets `TCP_NODELAY` so messages go out immediately.

The crypto is deliberately **not** in C. You don't hand-roll cryptography, so that lives in
the browser using the audited WebCrypto API. The C part only moves ciphertext around.

## Honest limits (please read before trusting it with anything real)

This is a learning project, not Signal. Being straight about what it is:

- **No protection against an active man-in-the-middle.** The key exchange assumes the relay
  passes public keys through honestly. A malicious relay could swap keys. Real apps prevent
  this with identity verification; this doesn't.
- **No forward secrecy or long-term identity.** Keys are per-session only.
- **Nicknames are unauthenticated.** They're a display convenience; nothing stops a peer
  from picking any name. Don't treat a name as proof of who you're talking to.
- **Group chat uses pairwise fan-out**, which is simple and correct but O(n) work per
  message. It's meant for small rooms, not large groups.
- **Calls use a mesh**, so each person uploads their stream to everyone else. That's fine
  for a handful of people but doesn't scale to large calls (an SFU media server would).
- **Calls need STUN/TURN to cross NATs.** Free public STUN plus a free community TURN are
  configured, so most calls connect, but some people behind strict/corporate firewalls may
  fail to connect without a paid TURN server. Call media is encrypted by WebRTC's own
  DTLS-SRTP, which is a different mechanism than the chat's end-to-end encryption.
- **Metadata isn't hidden from the relay operator.** They can see that connections joined
  a room and roughly when, just not what was said.
- **Not audited.** I wrote it to learn how E2EE and WebSockets work, and I'm not claiming it's
  bulletproof. Don't use it for anything where your safety depends on it.

The message contents themselves are genuinely encrypted end to end. I'd rather tell you the
edges than oversell it.

## Hardening the relay (against abuse, not against reading you)

The relay can't read messages, but it still has to survive hostile clients. Following the
OWASP WebSocket guidance, it:

- **Requires masked, well-formed frames** and rejects anything malformed, with every length
  bounds-checked against the bytes actually received (no buffer overrun).
- **Caps payloads at 64 KB** and rejects oversized frames.
- **Limits each room to 4 connections**, so a room can't be flooded.
- **Rate-limits each connection** (about 40 messages per 10 seconds) and drops abusers.
- **Reaps idle connections** after 2 minutes so abandoned sockets don't hold resources.
- **Logs nothing.** No request logs, no message logs, one startup line and that's it.

The WebSocket accept-key (SHA-1) is verified against the RFC 6455 test vector, so the
handshake is correct rather than "seems to work in my browser." See `SECURITY-AUDIT.md`
for the full checklist and what is deliberately out of scope.

## Run it

```bash
cc -O2 -Wall -o server server.c
./server 8080
```

Then serve the `public/` folder on the same origin (any static server works), for example:

```bash
cd public && python3 -m http.server 8081
```

Open `http://localhost:8081` in two browser tabs, enter the same room name in both, and chat.
For real use put it behind HTTPS/WSS (the client auto-uses `wss://` on an https page).

## Files

- `server.c` — the C WebSocket relay (no logs, no storage)
- `public/index.html` — the UI
- `public/crypto.js` — all the WebCrypto (ECDH + AES-GCM)
- `public/chat.js` — UI logic and the wire protocol

Built by Robin Malhotra. [robin-malhotra.vercel.app](https://robin-malhotra.vercel.app)

# chat-anoynm

A private chat that remembers nothing.

Two people share a room name, talk, and send files. Everything is encrypted in the
browser before it leaves, the server can't read any of it, and when you both close the
tab there's nothing left anywhere. No accounts, no message history, no logs.

I started this as a fun project and came back to finish it properly.

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
- **Metadata isn't hidden from the relay operator.** They can see that two connections joined
  a room and roughly when, just not what was said.
- **Not audited.** I wrote it to learn how E2EE and WebSockets work, and I'm not claiming it's
  bulletproof. Don't use it for anything where your safety depends on it.

The message contents themselves are genuinely encrypted end to end. I'd rather tell you the
edges than oversell it.

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

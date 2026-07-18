# Deploy status: LIVE ✅

- **Live demo:** https://chat-anoynm.vercel.app (open in two tabs, same room name)
- **Frontend:** Vercel (static page), public.
- **Relay:** C server on Render at https://chat-anoynm.onrender.com — returns
  `chat-anoynm relay ok` to a plain GET, and speaks WebSocket for the chat.

Verified end-to-end with a headless browser: the Vercel page connects to the Render
relay over wss://, the handshake succeeds (101 Switching Protocols), and clients reach
the encrypted "connected" state.

## Note on Render's free tier
The relay sleeps after ~15 min idle. The first connection after a quiet period takes
~30-60s to wake the container. After that it's instant. That's the trade-off for
card-free hosting and is normal, not a bug.

## What was fixed to get here
1. Server replies 200 to plain HTTP GET (Render health check).
2. Handshake recv() has a 5s timeout so silent probes can't hang the loop.
3. Binary is statically linked on a matching base image (no glibc mismatch crash).
4. The service had been suspended in the Render dashboard; resuming + the rebuild
   brought it up.

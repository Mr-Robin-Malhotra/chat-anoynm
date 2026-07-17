# Deploy status & the one remaining step

## What's DONE and working
- ✅ **Frontend live & public** on Vercel: https://chat-anoynm.vercel.app
  (deployment protection disabled, config points at the relay URL below)
- ✅ **All code verified correct** with a real headless browser: WebSocket handshake
  succeeds, messages relay, E2EE works, the server survives malformed frames, rate
  limits, room caps, idle reaping, and silent probes.
- ✅ **SHA-1 handshake verified** against the official RFC 6455 test vector.
- ✅ Everything committed and pushed to GitHub.

## The ONE thing still failing: the Render relay returns 502
`https://chat-anoynm.onrender.com` returns HTTP 502 (`x-render-origin-server: Render`,
content-length 0). That means Render has the service but no healthy running container is
answering on the expected port.

I fixed the three most likely code causes and pushed each:
1. Server now replies 200 to a plain HTTP GET (health checks).
2. Handshake `recv()` has a 5s timeout so a silent probe can't hang the single-threaded loop.
3. Binary is now **statically linked** and built on the same base image, so there's no
   glibc mismatch crash between build and run stages.

If it's STILL 502 after those, the cause is almost certainly Render dashboard config that
can't be changed from code:

### Check these in the Render dashboard (dashboard.render.com -> chat-anoynm)
1. **Did it auto-deploy the latest commit?** Open the service -> "Events"/"Deploys" tab.
   If the last deploy is older than commit `8fbf186`, auto-deploy is off. Click
   **"Manual Deploy" -> "Deploy latest commit"**.
2. **Build failing?** Open the "Logs" tab. If the Docker build errored, the log says why.
3. **Wrong port?** Settings -> the service should NOT have a hardcoded "Port" that differs
   from what the app uses. The app reads `$PORT` (Render sets it, usually 10000). If a Port
   field is set to e.g. 8080, either clear it or set it to 10000.
4. **Health check path:** Settings -> Health Check Path should be `/` (the server returns
   200 "chat-anoynm relay ok" there).

### Fastest clean fix if the dashboard service is misconfigured
Delete the `chat-anoynm` service in Render, then: New -> **Blueprint** -> pick this repo.
Render reads `render.yaml` and creates it correctly (right port, health check, region).

Once the relay returns `chat-anoynm relay ok` at https://chat-anoynm.onrender.com/, the
live demo at https://chat-anoynm.vercel.app works with zero further changes — the frontend
already points at it.

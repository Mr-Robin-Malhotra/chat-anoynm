# Prompt: fix the two-peer key-exchange handshake

## The bug (confirmed by a real user, two people on different networks)
Both connect, but they can't chat and one is stuck on "waiting for the other person."

## Root cause (analysed, not guessed)
The relay only forwards a message to OTHER clients already in the room. The old handshake:
1. Sends your public key ONCE, on `onopen`.
2. On receiving a key, `if (E2EE.ready()) return;` then derive + reply once.

Two failure modes fall out of that:
- **Lost first key:** whoever joins first broadcasts their key to an empty room, so it's
  dropped. If the second person's key is also mistimed or lost, the exchange never completes
  and someone waits forever. There is NO retry.
- **Reconnect deadlock:** on reconnect a peer resets and makes a NEW keypair, then sends it.
  The other peer is already `ready()`, so it hits `if (ready) return` and IGNORES the new
  key. The reconnecting peer never gets a reply (stuck "waiting"), and the two sides now hold
  mismatched keys, so even "connected" messages can't decrypt.

## The fix: WebRTC-style offer/answer with retries
Model it on how WebRTC signaling and similar peer handshakes actually work.

1. **Two roles on the `key` message:** `role:"offer"` and `role:"answer"`.
2. **On join/reconnect (`onopen`):** send an OFFER, and RETRY it every ~2s (cap ~8 tries)
   until the channel is up. Retries recover any lost first key.
3. **On receiving an OFFER:** ALWAYS derive the shared key from it (even if already ready —
   this is what fixes reconnect), then send back an ANSWER with your own key.
4. **On receiving an ANSWER:** derive the shared key. Do NOT reply. (This terminates the
   exchange — no infinite loop, because answers never trigger a reply.)
5. Track an `announced` flag so the "connected" status + system message show once, not on
   every re-derive.
6. Stop the offer-retry timer as soon as the channel is up.

### Why this is loop-free AND recovers
- offer -> answer -> stop. Answers don't reply, so at most 2 offers + 2 answers even if both
  peers offer simultaneously. ECDH gives both sides the same secret regardless of who offered.
- If a first offer is lost, the retry re-sends it until an answer arrives.
- On reconnect, the fresh offer forces the already-connected peer to re-derive with the new
  key and answer, so both converge on the new shared secret.

## Rules
- Keep E2EE intact (crypto stays in browser, relay stays blind).
- No guessing: TEST the real failure — simulate join-order (A first, long gap, then B) and a
  reconnect (drop one side, it comes back) and confirm both can chat afterwards.
- Verify with two SEPARATE browser instances (two pages hang in this env).

## Reference
WebRTC perfect-negotiation / offer-answer signaling pattern; general peer key-exchange over
an unreliable relay.

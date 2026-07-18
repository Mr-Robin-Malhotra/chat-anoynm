# Security audit prompt (self-directed) + findings

## The prompt I follow

Audit the chat-anoynm C relay + browser client against the OWASP WebSocket Cheat Sheet
and E2EE threat-model research. Rules:
- NO "1000% secure" claims. State residual risk honestly. This is a learning project.
- No guessing: for each item, quote the actual code behavior, then verdict.
- Fix only real, in-scope issues. A relay that can't read messages does NOT need to fix
  "message content validation" the way a trusted server would, but it MUST resist DoS,
  connection abuse, and malformed input that could crash it or corrupt other users.
- Keep the honest-limits section of the README accurate after any change.

## Threat model (what this design does and does not defend)

DEFENDS: passive network eavesdroppers and the relay operator reading message CONTENT
(content is E2E encrypted in the browser; the relay only sees ciphertext).

DOES NOT DEFEND (documented, by design for a learning project):
- Active MITM at key exchange (relay could swap public keys). No identity/auth layer.
- Metadata (who connected to which room, when) is visible to the relay operator.
- Forward secrecy / long-term identity: none.

## OWASP checklist -> current status -> action

| Requirement | Current behavior | Verdict / action |
|---|---|---|
| WSS only in prod | Client auto-uses wss:// on https pages; Fly forces https | OK |
| Origin validation | Server does not check Origin | ADD: it's a relay with no cookies/auth, so CSWSH risk is low (nothing to hijack), but reject obviously bad handshakes. Low priority. |
| RFC 6455, drop old versions | Server implements RFC 6455 accept-key only | OK |
| Message size limit (<=64KB) | recv buffer is 64KB; frames larger are REJECTED | OK (already enforced) |
| Reject malformed frames | Bounds-checked; unmasked/oversized frames drop the connection | OK (fixed earlier, tested) |
| Per-connection / total limits | MAX_CLIENTS=256 cap exists | PARTIAL: add a per-room cap so one room can't be flooded |
| Rate limiting | none | ADD: simple per-connection message rate cap to blunt spam/DoS |
| Idle timeout / ping-pong | none | ADD: drop connections with no data for N seconds (frees slots) |
| No logging of sensitive data | server logs NOTHING except one startup line | OK (exceeds requirement) |
| JSON.parse only, no eval | client uses JSON.parse in try/catch | OK |
| Replay protection | none at app layer | NOTE in README (out of scope for relay; AES-GCM IV is fresh per msg) |

## Concrete fixes to apply (in scope, real risk)
1. Per-room capacity cap (e.g. 4 connections/room) — prevents room flooding + limits
   who can receive relayed ciphertext.
2. Per-connection rate limit (e.g. max ~30 msgs / 10s) — blunts a spam/DoS client.
3. Idle timeout via poll() timeout — reclaim dead/abandoned sockets.
4. Keep bounds checking + masked-frame requirement (already done, verified).

These are the fixes a relay ACTUALLY needs. Auth/session/origin items from the generic
checklist mostly don't apply because there is no account, cookie, or trusted server state
to protect — which I state rather than pretend to "fix".

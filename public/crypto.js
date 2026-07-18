/*
 * All encryption happens here, in the browser, using the built-in WebCrypto API.
 * Nothing here ever leaves the page except public keys and ciphertext.
 *
 * Scheme:
 *   - Each person generates an ECDH P-256 key pair on load.
 *   - They swap PUBLIC keys through the relay (public keys are safe to send).
 *   - Both derive the same shared AES-GCM 256 key via ECDH. The relay never
 *     sees this key and can't compute it.
 *   - Every message/file is encrypted with AES-GCM using a fresh random IV.
 *
 * Honest limits (see README): this is a learning project, not Signal. There's
 * no long-term identity or forward secrecy, and it trusts the key exchange
 * isn't actively tampered with (no MITM protection). It's real encryption,
 * honestly scoped.
 *
 * Note the name E2EE: we deliberately avoid the name "Crypto" because the
 * browser already has a built-in global by that name, and redeclaring it in a
 * classic script throws and breaks the whole page.
 */

// Group-capable via PAIRWISE fan-out: one ECDH keypair for me, and a SEPARATE
// AES-GCM key derived with each peer (keyed by peerId). To send to the room I
// encrypt once per peer. The relay still only ever sees ciphertext.
const E2EE = (() => {
  let myKeys = null;
  const peerKeys = new Map();   // peerId -> derived AES-GCM CryptoKey

  async function init() {
    myKeys = await crypto.subtle.generateKey(
      { name: "ECDH", namedCurve: "P-256" },
      false,               // private key not extractable, so it can't leak
      ["deriveKey"]
    );
  }

  // Export our public key to send to peers (JWK, safe to transmit).
  async function publicKeyJwk() {
    return crypto.subtle.exportKey("jwk", myKeys.publicKey);
  }

  // Derive (and store) the shared AES key with a specific peer.
  async function deriveShared(peerId, peerJwk) {
    const peerKey = await crypto.subtle.importKey(
      "jwk", peerJwk, { name: "ECDH", namedCurve: "P-256" }, false, []
    );
    const key = await crypto.subtle.deriveKey(
      { name: "ECDH", public: peerKey },
      myKeys.privateKey,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"]
    );
    peerKeys.set(peerId, key);
  }

  const hasPeer = (peerId) => peerKeys.has(peerId);
  const peerIds = () => Array.from(peerKeys.keys());
  const ready = () => peerKeys.size > 0;       // connected to at least one peer
  function forget(peerId) { peerKeys.delete(peerId); }

  // Forget everything (on leave). init() makes a fresh keypair next time.
  function reset() { peerKeys.clear(); myKeys = null; }

  // Encrypt bytes for ONE peer -> { iv, data } as base64 strings.
  async function encryptFor(peerId, bytes) {
    const key = peerKeys.get(peerId);
    if (!key) return null;
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, bytes);
    return { iv: b64(iv), data: b64(new Uint8Array(ct)) };
  }

  // Decrypt { iv, data } from a specific peer -> Uint8Array.
  async function decryptFrom(peerId, iv, data) {
    const key = peerKeys.get(peerId);
    if (!key) throw new Error("no key for peer");
    const pt = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: unb64(iv) }, key, unb64(data)
    );
    return new Uint8Array(pt);
  }

  function b64(u8) { let s = ""; for (const b of u8) s += String.fromCharCode(b); return btoa(s); }
  function unb64(s) { const bin = atob(s); const u8 = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i); return u8; }

  return { init, publicKeyJwk, deriveShared, hasPeer, peerIds, ready, forget, reset, encryptFor, decryptFrom, b64, unb64 };
})();

window.E2EE = E2EE;

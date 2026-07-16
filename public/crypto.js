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
 */

const Crypto = (() => {
  let myKeys = null;
  let sharedKey = null;

  async function init() {
    myKeys = await crypto.subtle.generateKey(
      { name: "ECDH", namedCurve: "P-256" },
      false,               // private key not extractable — can't leak it
      ["deriveKey"]
    );
  }

  // Export our public key to send to the peer (JWK, safe to transmit).
  async function publicKeyJwk() {
    return crypto.subtle.exportKey("jwk", myKeys.publicKey);
  }

  // Given the peer's public key, derive the shared AES key.
  async function deriveShared(peerJwk) {
    const peerKey = await crypto.subtle.importKey(
      "jwk", peerJwk, { name: "ECDH", namedCurve: "P-256" }, false, []
    );
    sharedKey = await crypto.subtle.deriveKey(
      { name: "ECDH", public: peerKey },
      myKeys.privateKey,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"]
    );
  }

  const ready = () => sharedKey !== null;

  // Encrypt bytes -> { iv, data } as base64 strings.
  async function encrypt(bytes) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, sharedKey, bytes);
    return { iv: b64(iv), data: b64(new Uint8Array(ct)) };
  }

  // Decrypt { iv, data } -> Uint8Array.
  async function decrypt(iv, data) {
    const pt = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: unb64(iv) }, sharedKey, unb64(data)
    );
    return new Uint8Array(pt);
  }

  function b64(u8) { let s = ""; for (const b of u8) s += String.fromCharCode(b); return btoa(s); }
  function unb64(s) { const bin = atob(s); const u8 = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i); return u8; }

  return { init, publicKeyJwk, deriveShared, ready, encrypt, decrypt, b64, unb64 };
})();

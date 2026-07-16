/*
 * UI + wire protocol. Talks to the C relay over WebSocket.
 * The relay only ever sees the JSON below AFTER the payload is already
 * encrypted, so to the server it's meaningless scrambled text.
 *
 * Message types on the wire:
 *   { t:"key",  jwk:<public key> }              // key exchange
 *   { t:"msg",  iv, data }                       // encrypted text
 *   { t:"file", iv, data, name, mime }           // encrypted file (name/mime also encrypted)
 */

const enc = new TextEncoder();
const dec = new TextDecoder();
let ws = null;

const $ = (id) => document.getElementById(id);

$("join").onclick = start;
$("room").addEventListener("keydown", (e) => { if (e.key === "Enter") start(); });

async function start() {
  const room = $("room").value.trim();
  if (!room) return;

  await Crypto.init();

  // Server URL: same host, ws/wss depending on page protocol.
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const host = location.host || "localhost:8080";
  ws = new WebSocket(`${proto}://${host}/?room=${encodeURIComponent(room)}`);

  ws.onopen = async () => {
    $("setup").style.display = "none";
    $("chat").style.display = "flex";
    setStatus(false, "waiting for the other person…");
    // announce our public key so the peer can derive the shared secret
    send({ t: "key", jwk: await Crypto.publicKeyJwk() });
  };

  ws.onmessage = onMessage;
  ws.onclose = () => setStatus(false, "disconnected");
  ws.onerror = () => setStatus(false, "connection error");
}

async function onMessage(ev) {
  let m;
  try { m = JSON.parse(ev.data); } catch { return; }

  if (m.t === "key") {
    await Crypto.deriveShared(m.jwk);
    // reply with our key too, so whoever joined second also gets set up
    send({ t: "key", jwk: await Crypto.publicKeyJwk() });
    setStatus(true, "encrypted — you're connected");
    sys("Secure channel established. Messages are end-to-end encrypted.");
    return;
  }

  if (!Crypto.ready()) return; // ignore anything before keys are set

  if (m.t === "msg") {
    const bytes = await Crypto.decrypt(m.iv, m.data);
    addMsg(dec.decode(bytes), "them");
  } else if (m.t === "file") {
    const bytes = await Crypto.decrypt(m.iv, m.data);
    const name = dec.decode(await Crypto.decrypt(m.name.iv, m.name.data));
    const mime = dec.decode(await Crypto.decrypt(m.mime.iv, m.mime.data));
    const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
    const a = document.createElement("a");
    a.href = url; a.download = name; a.className = "file"; a.textContent = "📎 " + name;
    const wrap = document.createElement("div");
    wrap.className = "msg them"; wrap.appendChild(a);
    $("log").appendChild(wrap); scroll();
  }
}

// ---- sending ----
$("form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = $("text").value;
  if (!text || !Crypto.ready()) return;
  const { iv, data } = await Crypto.encrypt(enc.encode(text));
  send({ t: "msg", iv, data });
  addMsg(text, "me");
  $("text").value = "";
});

$("attach").onclick = () => $("file").click();
$("file").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file || !Crypto.ready()) return;
  if (file.size > 5 * 1024 * 1024) { sys("File too big (5 MB max for the demo)."); return; }
  const buf = new Uint8Array(await file.arrayBuffer());
  send({
    t: "file",
    ...(await Crypto.encrypt(buf)),
    name: await Crypto.encrypt(enc.encode(file.name)),
    mime: await Crypto.encrypt(enc.encode(file.type || "application/octet-stream")),
  });
  sys("Sent file: " + file.name);
  e.target.value = "";
});

// ---- helpers ----
function send(obj) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); }
function addMsg(text, who) { const d = document.createElement("div"); d.className = "msg " + who; d.textContent = text; $("log").appendChild(d); scroll(); }
function sys(text) { const d = document.createElement("div"); d.className = "msg sys"; d.textContent = text; $("log").appendChild(d); scroll(); }
function scroll() { $("log").scrollTop = $("log").scrollHeight; }
function setStatus(on, text) { $("dot").className = "dot" + (on ? " on" : ""); $("status").textContent = text; }

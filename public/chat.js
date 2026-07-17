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

let wired = false;
function wireUp() {
  if (wired) return;
  const join = $("join");
  if (!join) return;            // elements not in the DOM yet
  wired = true;
  join.onclick = () => { start().catch((e) => alert("Could not start: " + e.message)); };
  $("room").addEventListener("keydown", (e) => {
    if (e.key === "Enter") start().catch((err) => alert("Could not start: " + err.message));
  });
  $("attach").onclick = () => $("file").click();
  $("file").addEventListener("change", onFileChange);
  $("form").addEventListener("submit", onFormSubmit);
}

// Wire up no matter what state the page is in. The script sits at the end of
// <body>, so DOMContentLoaded may already have fired; cover every case.
wireUp();                                              // run now if DOM is ready
document.addEventListener("DOMContentLoaded", wireUp); // ...or when it becomes ready
window.addEventListener("load", wireUp);               // ...last-resort safety net

async function start() {
  const room = $("room").value.trim();
  if (!room) return;

  await E2EE.init();

  // Show the chat screen right away so the user gets feedback, then connect.
  $("setup").style.display = "none";
  $("chat").style.display = "flex";
  setStatus(false, "connecting…");

  // Where the C relay lives. Priority:
  //   1. ?ws=host:port in the URL (handy for testing)
  //   2. window.RELAY_URL set in config.js (used in production)
  //   3. local dev default: page on :8081 -> relay on :8080
  //   4. same host as the page
  const wsOverride = new URLSearchParams(location.search).get("ws");
  let wsUrl;
  if (wsOverride) {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    wsUrl = `${proto}://${wsOverride}`;
  } else if (window.RELAY_URL) {
    wsUrl = window.RELAY_URL;
  } else {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const host = location.port === "8081" ? `${location.hostname}:8080` : location.host;
    wsUrl = `${proto}://${host}`;
  }
  ws = new WebSocket(`${wsUrl}/?room=${encodeURIComponent(room)}`);

  ws.onopen = async () => {
    setStatus(false, "waiting for the other person…");
    // announce our public key so the peer can derive the shared secret
    send({ t: "key", jwk: await E2EE.publicKeyJwk() });
  };

  ws.onmessage = onMessage;
  ws.onclose = () => setStatus(false, "disconnected");
  ws.onerror = () => setStatus(false, "connection error (is the relay running on :8080?)");
}

async function onMessage(ev) {
  let m;
  try { m = JSON.parse(ev.data); } catch { return; }

  if (m.t === "key") {
    await E2EE.deriveShared(m.jwk);
    // reply with our key too, so whoever joined second also gets set up
    send({ t: "key", jwk: await E2EE.publicKeyJwk() });
    setStatus(true, "encrypted — you're connected");
    sys("Secure channel established. Messages are end-to-end encrypted.");
    return;
  }

  if (!E2EE.ready()) return; // ignore anything before keys are set

  if (m.t === "msg") {
    const bytes = await E2EE.decrypt(m.iv, m.data);
    addMsg(dec.decode(bytes), "them");
  } else if (m.t === "file") {
    const bytes = await E2EE.decrypt(m.iv, m.data);
    const name = dec.decode(await E2EE.decrypt(m.name.iv, m.name.data));
    const mime = dec.decode(await E2EE.decrypt(m.mime.iv, m.mime.data));
    const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
    const a = document.createElement("a");
    a.href = url; a.download = name; a.className = "file"; a.textContent = "📎 " + name;
    const wrap = document.createElement("div");
    wrap.className = "msg them"; wrap.appendChild(a);
    $("log").appendChild(wrap); scroll();
  }
}

// ---- sending ----
async function onFormSubmit(e) {
  e.preventDefault();
  const text = $("text").value;
  if (!text || !E2EE.ready()) return;
  const { iv, data } = await E2EE.encrypt(enc.encode(text));
  send({ t: "msg", iv, data });
  addMsg(text, "me");
  $("text").value = "";
}

async function onFileChange(e) {
  const file = e.target.files[0];
  if (!file || !E2EE.ready()) return;
  if (file.size > 5 * 1024 * 1024) { sys("File too big (5 MB max for the demo)."); return; }
  const buf = new Uint8Array(await file.arrayBuffer());
  send({
    t: "file",
    ...(await E2EE.encrypt(buf)),
    name: await E2EE.encrypt(enc.encode(file.name)),
    mime: await E2EE.encrypt(enc.encode(file.type || "application/octet-stream")),
  });
  sys("Sent file: " + file.name);
  e.target.value = "";
}

// ---- helpers ----
function send(obj) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); }
function addMsg(text, who) { const d = document.createElement("div"); d.className = "msg " + who; d.textContent = text; $("log").appendChild(d); scroll(); }
function sys(text) { const d = document.createElement("div"); d.className = "msg sys"; d.textContent = text; $("log").appendChild(d); scroll(); }
function scroll() { $("log").scrollTop = $("log").scrollHeight; }
function setStatus(on, text) { $("dot").className = "dot" + (on ? " on" : ""); $("status").textContent = text; }

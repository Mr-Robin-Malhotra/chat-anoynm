/*
 * chat-anoynm client. Talks to the blind C relay over WebSocket.
 * Everything except tiny control signals is end-to-end encrypted in the browser,
 * so to the relay it's all opaque scrambled text.
 *
 * Wire types (all relayed as opaque JSON the server can't understand):
 *   { t:"key",   jwk }                        key exchange
 *   { t:"msg",   iv, data }                   encrypted text
 *   { t:"file",  iv, data, name, mime, size } encrypted file
 *   { t:"typing" }                            presence signal (not secret)
 *   { t:"ping" }                              heartbeat (not secret)
 */

const enc = new TextEncoder();
const dec = new TextDecoder();
const $ = (id) => document.getElementById(id);

// ---- connection state ----
let ws = null;
let room = "";
let manualClose = false;      // true when the user hit "leave"
let reconnectAttempts = 0;
let reconnectTimer = null;
let heartbeatTimer = null;
let lastPong = 0;
let peerTypingTimer = null;
let myTypingSent = 0;

const MAX_FILE = 8 * 1024 * 1024;         // 8 MB
const HEARTBEAT_MS = 15000;
const DEAD_MS = 40000;                      // no traffic this long -> reconnect
const MAX_RECONNECT_DELAY = 30000;

// ---- wire up UI (works whether DOM already loaded or not) ----
function wire() {
  if (!$("join")) return;
  $("join").onclick = () => joinFromInput();
  $("room").addEventListener("keydown", (e) => { if (e.key === "Enter") joinFromInput(); });
  $("form").addEventListener("submit", onSubmit);
  $("attach").onclick = () => $("file").click();
  $("file").addEventListener("change", (e) => { if (e.target.files[0]) sendFile(e.target.files[0]); e.target.value = ""; });
  $("copyLink").onclick = copyInviteLink;
  $("leave").onclick = leaveRoom;
  const ta = $("text");
  ta.addEventListener("input", () => { autoGrow(ta); signalTyping(); });
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); onSubmit(e); }
  });
  setupDragDrop();
  // pre-fill room from ?room= so invite links work
  const preset = new URLSearchParams(location.search).get("room");
  if (preset) { $("room").value = preset; }
}
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", wire);
else wire();

function joinFromInput() {
  const r = $("room").value.trim();
  if (!r) { shake($("room")); return; }
  room = r;
  manualClose = false;
  reconnectAttempts = 0;
  $("setup").style.display = "none";
  $("chat").style.display = "flex";
  $("roomTag").textContent = "#" + room;
  $("text").focus();
  connect();
}

// ---- connection with auto-reconnect + heartbeat ----
function relayBase() {
  const wsOverride = new URLSearchParams(location.search).get("ws");
  if (wsOverride) return (location.protocol === "https:" ? "wss" : "ws") + "://" + wsOverride;
  if (window.RELAY_URL) return window.RELAY_URL;
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const host = location.port === "8081" ? location.hostname + ":8080" : location.host;
  return proto + "://" + host;
}

async function connect() {
  setStatus("connecting", reconnectAttempts ? "reconnecting…" : "connecting…");
  try { await E2EE.init(); } catch { fail("This browser can't do the required encryption."); return; }

  try {
    ws = new WebSocket(relayBase() + "/?room=" + encodeURIComponent(room));
  } catch { scheduleReconnect(); return; }

  ws.onopen = async () => {
    reconnectAttempts = 0;
    lastPong = Date.now();
    setStatus("connecting", "waiting for the other person…");
    startHeartbeat();
    send({ t: "key", jwk: await E2EE.publicKeyJwk() });
  };
  ws.onmessage = onMessage;
  ws.onclose = () => { stopHeartbeat(); if (!manualClose) scheduleReconnect(); };
  ws.onerror = () => { /* onclose will follow and handle reconnect */ };
}

function scheduleReconnect() {
  if (manualClose) return;
  E2EE.reset();
  setStatus("reconnecting", "connection lost — reconnecting…");
  reconnectAttempts++;
  // exponential backoff with jitter, capped
  const base = Math.min(1000 * Math.pow(1.5, reconnectAttempts), MAX_RECONNECT_DELAY);
  const delay = base * (0.8 + Math.random() * 0.4);
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connect, delay);
}

function startHeartbeat() {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    if (Date.now() - lastPong > DEAD_MS) { try { ws.close(); } catch {} return; }
    send({ t: "ping" });
  }, HEARTBEAT_MS);
}
function stopHeartbeat() { clearInterval(heartbeatTimer); heartbeatTimer = null; }

// ---- incoming ----
async function onMessage(ev) {
  lastPong = Date.now();
  let m; try { m = JSON.parse(ev.data); } catch { return; }

  if (m.t === "ping") return;                    // heartbeat, ignore

  if (m.t === "key") {
    if (E2EE.ready()) return;                     // channel already up: no loop
    try { await E2EE.deriveShared(m.jwk); } catch { return; }
    send({ t: "key", jwk: await E2EE.publicKeyJwk() });
    setStatus("connected", "encrypted — you're connected");
    sys("Secure channel established. Messages are end-to-end encrypted.");
    return;
  }

  if (!E2EE.ready()) return;

  if (m.t === "typing") { showPeerTyping(); return; }

  if (m.t === "msg") {
    let text; try { text = dec.decode(await E2EE.decrypt(m.iv, m.data)); }
    catch { return; }
    addMessage(text, "them", m.ts);
  } else if (m.t === "file") {
    try {
      const bytes = await E2EE.decrypt(m.iv, m.data);
      const name = dec.decode(await E2EE.decrypt(m.name.iv, m.name.data));
      const mime = dec.decode(await E2EE.decrypt(m.mime.iv, m.mime.data));
      addFile(bytes, name, mime, m.size, "them", m.ts);
    } catch { sys("Couldn't decrypt a file that was sent.", true); }
  }
}

// ---- outgoing ----
async function onSubmit(e) {
  if (e) e.preventDefault();
  const ta = $("text");
  const text = ta.value.trim();
  if (!text) return;
  if (!E2EE.ready()) { toast("Not connected yet — hang on a second."); return; }
  const ts = Date.now();
  try {
    const { iv, data } = await E2EE.encrypt(enc.encode(text));
    send({ t: "msg", iv, data, ts });
    addMessage(text, "me", ts);
    ta.value = ""; autoGrow(ta); ta.focus();
  } catch { toast("Couldn't send that message."); }
}

async function sendFile(file) {
  if (!E2EE.ready()) { toast("Not connected yet."); return; }
  if (file.size > MAX_FILE) { toast("File too big (8 MB max)."); return; }
  const ts = Date.now();
  const row = addUploadingRow(file.name, file.size);
  try {
    const buf = new Uint8Array(await file.arrayBuffer());
    row.setProgress(50);
    const payload = {
      t: "file", ts, size: file.size,
      ...(await E2EE.encrypt(buf)),
      name: await E2EE.encrypt(enc.encode(file.name)),
      mime: await E2EE.encrypt(enc.encode(file.type || "application/octet-stream")),
    };
    row.setProgress(100);
    send(payload);
    row.replaceWithFile(buf, file.name, file.type, file.size, ts);
  } catch {
    row.setError();
    toast("Couldn't send that file.");
  }
}

// ---- typing indicator ----
function signalTyping() {
  const now = Date.now();
  if (E2EE.ready() && now - myTypingSent > 1500) { myTypingSent = now; send({ t: "typing" }); }
}
function showPeerTyping() {
  $("typing").classList.add("show");
  clearTimeout(peerTypingTimer);
  peerTypingTimer = setTimeout(() => $("typing").classList.remove("show"), 2500);
}

// ---- rendering ----
function addMessage(text, who, ts) {
  const row = document.createElement("div");
  row.className = "row " + who;
  const b = document.createElement("div"); b.className = "bubble"; b.textContent = text;
  const meta = document.createElement("div"); meta.className = "meta"; meta.textContent = fmtTime(ts);
  row.append(b, meta); $("log").appendChild(row); scrollDown();
}

function addFile(bytes, name, mime, size, who, ts) {
  const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
  const row = document.createElement("div"); row.className = "row " + who;
  const b = document.createElement("div"); b.className = "bubble";
  if (mime && mime.startsWith("image/")) {
    const a = document.createElement("a"); a.href = url; a.download = name;
    const img = document.createElement("img"); img.className = "img-att"; img.src = url; img.alt = name;
    a.appendChild(img); b.appendChild(a);
  } else {
    const a = document.createElement("a"); a.href = url; a.download = name; a.className = "file-att";
    a.innerHTML = '<span class="fi"><svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 3v4a1 1 0 0 0 1 1h4"/><path d="M17 21H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7l5 5v11a2 2 0 0 1-2 2z"/></svg></span>';
    const info = document.createElement("span");
    info.innerHTML = '<span class="fn">' + escapeHtml(name) + '</span><br><span class="fs">' + fmtSize(size) + '</span>';
    a.appendChild(info); b.appendChild(a);
  }
  const meta = document.createElement("div"); meta.className = "meta"; meta.textContent = fmtTime(ts);
  row.append(b, meta); $("log").appendChild(row); scrollDown();
}

function addUploadingRow(name, size) {
  const row = document.createElement("div"); row.className = "row me";
  const b = document.createElement("div"); b.className = "bubble";
  b.innerHTML = '<div class="file-att"><span class="fi">⬆</span><span><span class="fn">' +
    escapeHtml(name) + '</span><br><span class="fs prog">' + fmtSize(size) + ' · 0%</span></span></div>';
  row.appendChild(b); $("log").appendChild(row); scrollDown();
  const prog = b.querySelector(".prog");
  return {
    setProgress: (p) => { prog.textContent = fmtSize(size) + " · " + p + "%"; },
    setError: () => { prog.textContent = "failed to send"; prog.style.color = "var(--red)"; },
    replaceWithFile: (bytes, n, mime, s, ts) => {
      row.remove(); addFile(bytes, n, mime, s, "me", ts);
    },
  };
}

// ---- controls ----
function copyInviteLink() {
  const link = location.origin + location.pathname + "?room=" + encodeURIComponent(room);
  navigator.clipboard?.writeText(link).then(
    () => toast("Invite link copied"),
    () => toast(link)
  );
}
function leaveRoom() {
  manualClose = true;
  clearTimeout(reconnectTimer); stopHeartbeat();
  try { ws && ws.close(); } catch {}
  E2EE.reset();
  $("log").innerHTML = ""; $("typing").classList.remove("show");
  $("chat").style.display = "none"; $("setup").style.display = "block";
  $("room").value = ""; $("room").focus();
  history.replaceState(null, "", location.pathname);
}

// ---- helpers ----
function send(obj) { try { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); } catch {} }
function setStatus(cls, text) { $("dot").className = "dot " + cls; $("status").textContent = text; $("send").disabled = cls !== "connected"; }
function sys(text, isErr) { const d = document.createElement("div"); d.className = "sys" + (isErr ? " err" : ""); d.textContent = text; $("log").appendChild(d); scrollDown(); }
function fail(text) { setStatus("", "error"); sys(text, true); }
function scrollDown() { const l = $("log"); l.scrollTop = l.scrollHeight; }
function autoGrow(ta) { ta.style.height = "auto"; ta.style.height = Math.min(ta.scrollHeight, 120) + "px"; }
function fmtTime(ts) { const d = ts ? new Date(ts) : new Date(); return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); }
function fmtSize(n) { if (n < 1024) return n + " B"; if (n < 1048576) return (n / 1024).toFixed(1) + " KB"; return (n / 1048576).toFixed(1) + " MB"; }
function escapeHtml(s) { return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
function shake(el) { el.style.borderColor = "var(--red)"; el.focus(); setTimeout(() => (el.style.borderColor = ""), 1200); }

let toastTimer = null;
function toast(text) { const t = $("toast"); t.textContent = text; t.classList.add("show"); clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove("show"), 2600); }

// ---- drag & drop ----
function setupDragDrop() {
  const drop = $("drop");
  let depth = 0;
  window.addEventListener("dragenter", (e) => { e.preventDefault(); if (++depth === 1 && $("chat").style.display !== "none") drop.classList.add("show"); });
  window.addEventListener("dragover", (e) => e.preventDefault());
  window.addEventListener("dragleave", (e) => { e.preventDefault(); if (--depth <= 0) { depth = 0; drop.classList.remove("show"); } });
  window.addEventListener("drop", (e) => {
    e.preventDefault(); depth = 0; drop.classList.remove("show");
    const f = e.dataTransfer?.files?.[0];
    if (f && $("chat").style.display !== "none") sendFile(f);
  });
}

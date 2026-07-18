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
let offerTimer = null;
let fastOfferTimer = null;
let announced = false;     // shown the "connected" state for this session
let lastPong = 0;
let peerTypingTimer = null;
let myTypingSent = 0;

// Identity for group chat. myId is a stable random id for this session; peers
// is the roster of everyone we've shaken hands with (peerId -> {name}).
const myId = Math.random().toString(36).slice(2, 10);
let myName = "Anonymous";
const peers = new Map();      // peerId -> { name }

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
  $("reply-cancel").onclick = cancelReply;
  const ta = $("text");
  ta.addEventListener("input", () => { autoGrow(ta); signalTyping(); });
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); onSubmit(e); }
    if (e.key === "Escape" && replyingTo) { e.preventDefault(); cancelReply(); }
  });
  setupDragDrop();
  setupMobileKeyboard();
  // pre-fill room from ?room= so invite links work
  const preset = new URLSearchParams(location.search).get("room");
  if (preset) { $("room").value = preset; }
}

// Keep the composer and newest message visible when the phone keyboard opens.
// visualViewport shrinks when the keyboard shows; we match the app height to it
// and scroll the log to the bottom so messages don't hide behind the keyboard.
function setupMobileKeyboard() {
  const vv = window.visualViewport;
  if (!vv) return;
  const apply = () => {
    document.documentElement.style.setProperty("--app-h", vv.height + "px");
    scrollDown();
  };
  vv.addEventListener("resize", apply);
  vv.addEventListener("scroll", apply);
  // When the message box is focused, make sure the latest message stays in view.
  $("text").addEventListener("focus", () => setTimeout(scrollDown, 100));
  apply();
}
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", wire);
else wire();

function joinFromInput() {
  const r = $("room").value.trim();
  if (!r) { shake($("room")); return; }
  const nm = ($("nick") ? $("nick").value.trim() : "");
  myName = nm ? nm.slice(0, 24) : "Anonymous";
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
    announced = false;
    setStatus("connecting", "waiting for the other person…");
    startHeartbeat();
    startOffer();          // send an offer, and keep retrying until connected
  };
  ws.onmessage = onMessage;
  ws.onclose = () => { stopHeartbeat(); stopOffer(); if (!manualClose) scheduleReconnect(); };
  ws.onerror = () => { /* onclose will follow and handle reconnect */ };
}

// Broadcast a key "offer" (to the whole room) and re-send periodically so late
// joiners and anyone whose first offer was lost still shake hands. In a group,
// every member offers, and each pair completes its own ECDH. Retries keep going
// a while so newcomers always get picked up.
async function startOffer() {
  stopOffer();
  const myJwk = await E2EE.publicKeyJwk();
  const sendOffer = () => send({ t: "key", role: "offer", from: myId, name: myName, jwk: myJwk });
  sendOffer();
  // Offer quickly at first so the room meshes fast (new joiners get picked up in
  // well under a second), then slow down to occasional keep-alive offers that
  // catch anyone who joins later.
  let tries = 0;
  fastOfferTimer = setInterval(sendOffer, 400);
  setTimeout(() => { clearInterval(fastOfferTimer); fastOfferTimer = null; }, 3000);
  offerTimer = setInterval(() => {
    if (++tries > 40) { stopOffer(); return; }   // ~80s of slow keep-alive
    sendOffer();
  }, 2000);
}
function stopOffer() { clearInterval(offerTimer); offerTimer = null; clearInterval(fastOfferTimer); fastOfferTimer = null; }

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
    // Group handshake: pairwise offer/answer, addressed by peer id.
    // - Ignore my own broadcasts, and answers meant for someone else.
    // - Always (re)derive a key with that peer, so reconnects re-sync.
    // - An OFFER earns an ANSWER back to that peer; an ANSWER ends the exchange
    //   (no reply), so there's no loop even with several people offering.
    if (!m.from || m.from === myId) return;
    if (m.role === "answer" && m.to !== myId) return;
    try { await E2EE.deriveShared(m.from, m.jwk); } catch { return; }
    const known = peers.has(m.from);
    peers.set(m.from, { name: (m.name || "Anonymous").slice(0, 24) });
    if (m.role === "offer") {
      send({ t: "key", role: "answer", from: myId, to: m.from, name: myName, jwk: await E2EE.publicKeyJwk() });
    }
    if (!known) sys((m.name || "Someone") + " joined.");
    updateRoster();
    flushPending(m.from);   // deliver any messages that arrived before this key
    if (!announced) {
      announced = true;
      setStatus("connected", "encrypted — end-to-end");
    }
    return;
  }

  if (!E2EE.ready()) return;

  if (m.t === "bye" && m.from) {
    const p = peers.get(m.from);
    if (p) { sys((p.name || "Someone") + " left."); peers.delete(m.from); E2EE.forget(m.from); updateRoster(); }
    return;
  }

  if (m.t === "typing") { showPeerTyping(peers.get(m.from)?.name); return; }

  if (m.t === "msg") {
    // In a group, a sender fans out one ciphertext per recipient. Only handle
    // the copy addressed to me, decrypted with that sender's key.
    if (m.to && m.to !== myId) return;
    if (!m.from) return;
    // A message can arrive a hair before our handshake with that sender finishes
    // (they meshed slightly faster). Hold it and replay once we have the key,
    // instead of dropping it.
    if (!E2EE.hasPeer(m.from)) { queuePending(m.from, m); return; }
    if (m.id && seenMsgIds.has(m.id)) return;   // dedupe (live + outbox replay)
    if (m.id) { seenMsgIds.add(m.id); if (seenMsgIds.size > 500) seenMsgIds.clear(); }
    let text; try { text = dec.decode(await E2EE.decryptFrom(m.from, m.iv, m.data)); }
    catch { return; }
    addMessage(text, "them", m.ts, m.id, m.replyTo, peers.get(m.from)?.name);
  } else if (m.t === "file-start") {
    if (m.to && m.to !== myId) return;
    if (!m.from) return;
    if (!E2EE.hasPeer(m.from)) { queuePending(m.from, m); return; }
    incoming.set(m.id, { from: m.from, iv: m.iv, name: m.name, mime: m.mime, size: m.size, ts: m.ts, total: m.total, parts: new Array(m.total), got: 0 });
  } else if (m.t === "file-chunk") {
    if (m.to && m.to !== myId) return;
    const f = incoming.get(m.id);
    if (!f || f.parts[m.i] !== undefined) return;
    f.parts[m.i] = m.part; f.got++;
    if (f.got === f.total) {
      incoming.delete(m.id);
      try {
        const bytes = await E2EE.decryptFrom(f.from, f.iv, f.parts.join(""));
        const name = dec.decode(await E2EE.decryptFrom(f.from, f.name.iv, f.name.data));
        const mime = dec.decode(await E2EE.decryptFrom(f.from, f.mime.iv, f.mime.data));
        addFile(bytes, name, mime, f.size, "them", f.ts, peers.get(f.from)?.name);
      } catch { sys("Couldn't decrypt a file that was sent.", true); }
    }
  }
}

// Reassembly buffer for incoming chunked files, keyed by file id.
const incoming = new Map();

// Messages that arrived just before the sender's key was ready, held per peer
// and replayed the moment the handshake with that peer completes.
const pending = new Map();     // peerId -> [messages]
const seenMsgIds = new Set();  // dedupe messages delivered twice (live + replay)
function queuePending(peerId, m) {
  if (!pending.has(peerId)) pending.set(peerId, []);
  const q = pending.get(peerId);
  if (q.length < 50) q.push(m);   // bounded, so a bad peer can't grow it forever
}
function flushPending(peerId) {
  const q = pending.get(peerId);
  if (q) { pending.delete(peerId); for (const m of q) onMessage({ data: JSON.stringify(m) }); }
  // Also send this newly-keyed peer any of my recent text messages they may have
  // missed while we were still shaking hands (covers the mesh-timing race).
  sendOutboxTo(peerId);
}

// Short-lived record of my recent OWN text messages, so a peer who finishes the
// handshake a moment late still receives them. Bounded and time-limited.
const outbox = [];   // { plain, ts, id, replyTo }
function rememberOutgoing(rec) { outbox.push(rec); if (outbox.length > 30) outbox.shift(); }
async function sendOutboxTo(peerId) {
  const cutoff = Date.now() - 20000;   // only messages from the last 20s
  for (const o of outbox) {
    if (o.ts < cutoff) continue;
    const ct = await E2EE.encryptFor(peerId, enc.encode(o.plain));
    if (ct) send({ t: "msg", from: myId, to: peerId, iv: ct.iv, data: ct.data, ts: o.ts, id: o.id, replyTo: o.replyTo });
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
  const id = fileId();
  const replyTo = replyingTo ? { id: replyingTo.id, preview: replyingTo.preview } : null;
  try {
    // Fan out: encrypt once per peer with that peer's key, send addressed copies.
    const bytes = enc.encode(text);
    for (const pid of E2EE.peerIds()) {
      const ct = await E2EE.encryptFor(pid, bytes);
      if (ct) send({ t: "msg", from: myId, to: pid, iv: ct.iv, data: ct.data, ts, id, replyTo });
    }
    rememberOutgoing({ plain: text, ts, id, replyTo });   // for peers who mesh a moment late
    addMessage(text, "me", ts, id, replyTo);
    ta.value = ""; autoGrow(ta); cancelReply(); ta.focus();
  } catch { toast("Couldn't send that message."); }
}

async function sendFile(file) {
  if (!E2EE.ready()) { toast("Not connected yet."); return; }
  if (file.size > MAX_FILE) { toast("File too big (8 MB max)."); return; }
  const ts = Date.now();
  const row = addUploadingRow(file.name, file.size);
  try {
    // For images: re-encode through a canvas to strip EXIF/GPS/camera metadata
    // before it ever leaves the browser. The picture looks identical, but it no
    // longer leaks where or when it was taken, or what device took it. This is
    // the "anonymous" part: the file carries no hidden identifying data.
    let buf, outName = file.name, outType = file.type;
    if (file.type && file.type.startsWith("image/")) {
      const cleaned = await stripImageMetadata(file);
      if (cleaned) { buf = cleaned.bytes; outType = cleaned.type; outName = renameStripped(file.name, cleaned.type); }
    }
    if (!buf) buf = new Uint8Array(await file.arrayBuffer());

    // A file goes as a stream of small chunk messages the receiver reassembles.
    // Chunks are kept SMALL (~8 KB) so the hosting proxy in front of the relay
    // never splits one chunk's WebSocket frame into fragments (which would
    // truncate it). In a group we fan out: encrypt per peer (their own key) and
    // stream an addressed copy to each. Name/mime ride on the "file-start".
    const CHUNK = 3000;                        // base64 chars/chunk. MEASURED: the
    // hosting proxy re-frames WebSocket frames larger than ~4 KB into separate
    // frames, which breaks a single chunk. Keeping each chunk's frame under 4 KB
    // (chunk + JSON overhead + mask) makes the proxy pass it through untouched.
    const nameBytes = enc.encode(outName);
    const mimeBytes = enc.encode(outType || "application/octet-stream");
    const pids = E2EE.peerIds();
    let done = 0;
    for (const pid of pids) {
      const { iv, data } = await E2EE.encryptFor(pid, buf);
      const name = await E2EE.encryptFor(pid, nameBytes);
      const mime = await E2EE.encryptFor(pid, mimeBytes);
      const id = fileId();
      const total = Math.ceil(data.length / CHUNK) || 1;
      send({ t: "file-start", from: myId, to: pid, id, ts, size: buf.length, iv, name, mime, total });
      await new Promise((r) => setTimeout(r, 15));
      for (let i = 0; i < total; i++) {
        send({ t: "file-chunk", from: myId, to: pid, id, i, part: data.slice(i * CHUNK, (i + 1) * CHUNK) });
        row.setProgress(Math.round((((done + (i + 1) / total)) / pids.length) * 100));
        await new Promise((r) => setTimeout(r, 12)); // pace so chunks don't batch and drop
      }
      done++;
    }
    row.replaceWithFile(buf, outName, outType, buf.length, ts);
  } catch {
    row.setError();
    toast("Couldn't send that file.");
  }
}

let fileCounter = 0;
function fileId() { return Date.now().toString(36) + "-" + (fileCounter++); }

// Full-screen image viewer. Click the backdrop or press Esc to close.
function openLightbox(url, name) {
  const box = document.createElement("div");
  box.className = "lightbox";
  const img = document.createElement("img"); img.src = url; img.alt = name;
  box.appendChild(img);
  box.onclick = () => close();
  function close() { box.remove(); document.removeEventListener("keydown", onKey); }
  function onKey(e) { if (e.key === "Escape") close(); }
  document.addEventListener("keydown", onKey);
  document.body.appendChild(box);
}

// Re-encode an image through a canvas. Canvas output contains ONLY pixels, so
// all EXIF/GPS/IPTC/XMP metadata is dropped. Returns cleaned bytes, or null if
// the image can't be decoded (then we fall back to sending it as-is).
function stripImageMetadata(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
        canvas.getContext("2d").drawImage(img, 0, 0);
        // PNG for images with transparency, JPEG otherwise (smaller, no alpha).
        const outType = /png|gif/i.test(file.type) ? "image/png" : "image/jpeg";
        canvas.toBlob(async (blob) => {
          URL.revokeObjectURL(url);
          if (!blob) return resolve(null);
          resolve({ bytes: new Uint8Array(await blob.arrayBuffer()), type: outType });
        }, outType, 0.92);
      } catch { URL.revokeObjectURL(url); resolve(null); }
    };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
    img.src = url;
  });
}

function renameStripped(name, type) {
  const ext = type === "image/png" ? ".png" : ".jpg";
  const base = name.replace(/\.[^.]+$/, "");
  return base + ext;
}

// ---- typing indicator ----
function signalTyping() {
  const now = Date.now();
  if (E2EE.ready() && now - myTypingSent > 1500) { myTypingSent = now; send({ t: "typing", from: myId }); }
}
function showPeerTyping(name) {
  const label = $("typing").querySelector(".t-label");
  if (label) label.textContent = (peers.size > 1 && name) ? name + " is typing" : "";
  $("typing").classList.add("show");
  clearTimeout(peerTypingTimer);
  peerTypingTimer = setTimeout(() => $("typing").classList.remove("show"), 2500);
}

// ---- roster (who's in the room) ----
function updateRoster() {
  const n = peers.size + 1; // +1 for me
  const tag = $("peopleCount");
  if (tag) tag.textContent = n <= 1 ? "just you" : n + " people";
  const list = $("rosterList");
  if (list) {
    list.innerHTML = "";
    const mine = document.createElement("div"); mine.className = "roster-item";
    mine.textContent = myName + " (you)"; list.appendChild(mine);
    for (const { name } of peers.values()) {
      const it = document.createElement("div"); it.className = "roster-item";
      it.textContent = name || "Anonymous"; list.appendChild(it);
    }
  }
}

// ---- rendering ----
// Registry of shown messages so a reply can quote and scroll back to them.
const msgStore = new Map();   // id -> { who, preview }

// Build a row with a reply button and (optional) quoted preview. Shared by
// text and file messages.
function makeRow(who, ts, id, replyTo, senderName) {
  const row = document.createElement("div");
  row.className = "row " + who;
  row.dataset.id = id;
  const wrap = document.createElement("div"); wrap.className = "bubble-wrap";
  const b = document.createElement("div"); b.className = "bubble";

  // In a group (more than one peer), label incoming bubbles with the sender's
  // name so you can tell who's who. Skipped for your own messages and 1:1 chats.
  if (who === "them" && senderName && peers.size > 1) {
    const nm = document.createElement("div"); nm.className = "sender"; nm.textContent = senderName;
    b.appendChild(nm);
  }

  if (replyTo) {
    // Label from the viewer's perspective: a quoted message that this viewer
    // sent shows "You", otherwise "Them". Fall back to stored who if known.
    const origWho = msgStore.has(replyTo.id) ? msgStore.get(replyTo.id).who : (who === "me" ? "them" : "me");
    const q = document.createElement("div"); q.className = "quote";
    const label = document.createElement("span"); label.className = "q-who";
    label.textContent = origWho === "me" ? "You" : "Them";
    q.appendChild(label);
    q.appendChild(document.createTextNode(replyTo.preview));
    q.title = "Jump to message";
    q.onclick = () => jumpTo(replyTo.id);
    b.appendChild(q);
  }

  const rbtn = document.createElement("button");
  rbtn.className = "reply-btn"; rbtn.title = "Reply"; rbtn.setAttribute("aria-label", "Reply");
  rbtn.innerHTML = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 17 4 12 9 7"/><path d="M20 18v-2a4 4 0 0 0-4-4H4"/></svg>';

  wrap.append(b, rbtn);
  return { row, wrap, b, rbtn };
}

function addMessage(text, who, ts, id, replyTo, senderName) {
  id = id || fileId();
  const { row, wrap, b, rbtn } = makeRow(who, ts, id, replyTo, senderName);
  const span = document.createElement("span"); span.textContent = text; b.appendChild(span);
  const preview = text.length > 60 ? text.slice(0, 60) + "…" : text;
  msgStore.set(id, { who, preview });
  rbtn.onclick = () => startReply(id, who, preview);
  const meta = document.createElement("div"); meta.className = "meta"; meta.textContent = fmtTime(ts);
  row.append(wrap, meta);
  $("log").appendChild(row); scrollDown();
}

// Scroll to and briefly highlight the message a quote points at.
function jumpTo(id) {
  const el = $("log").querySelector('[data-id="' + CSS.escape(id) + '"]');
  if (!el) return;
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  el.classList.remove("flash"); void el.offsetWidth; el.classList.add("flash");
}

// Reply state: what the next sent message will quote.
let replyingTo = null;
function startReply(id, who, preview) {
  replyingTo = { id, preview };
  $("reply-text").textContent = preview;
  $("reply-bar").classList.add("show");
  $("text").focus();
}
function cancelReply() {
  replyingTo = null;
  $("reply-bar").classList.remove("show");
}

function addFile(bytes, name, mime, size, who, ts, senderName) {
  const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
  const id = fileId();
  const isImg = mime && mime.startsWith("image/");
  const { row, wrap, b, rbtn } = makeRow(who, ts, id, null, senderName);
  if (isImg) {
    // Click the image to VIEW it full-size in a lightbox (not force a download).
    const img = document.createElement("img"); img.className = "img-att"; img.src = url; img.alt = name;
    img.style.cursor = "zoom-in";
    img.onclick = () => openLightbox(url, name);
    b.appendChild(img);
    const save = document.createElement("a");
    save.href = url; save.download = name; save.className = "img-save"; save.textContent = "Save";
    b.appendChild(save);
  } else {
    const a = document.createElement("a"); a.href = url; a.download = name; a.className = "file-att";
    a.innerHTML = '<span class="fi"><svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 3v4a1 1 0 0 0 1 1h4"/><path d="M17 21H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7l5 5v11a2 2 0 0 1-2 2z"/></svg></span>';
    const info = document.createElement("span");
    info.innerHTML = '<span class="fn">' + escapeHtml(name) + '</span><br><span class="fs">' + fmtSize(size) + '</span>';
    a.appendChild(info); b.appendChild(a);
  }
  const preview = (isImg ? "📷 " : "📎 ") + name;
  msgStore.set(id, { who, preview });
  rbtn.onclick = () => startReply(id, who, preview);
  const meta = document.createElement("div"); meta.className = "meta"; meta.textContent = fmtTime(ts);
  row.append(wrap, meta); $("log").appendChild(row); scrollDown();
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
  try { send({ t: "bye", from: myId }); } catch {}   // let peers remove me cleanly
  clearTimeout(reconnectTimer); stopHeartbeat(); stopOffer();
  try { ws && ws.close(); } catch {}
  E2EE.reset(); peers.clear();
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

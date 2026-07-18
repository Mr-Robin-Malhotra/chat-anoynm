/*
 * Call overlay UI: a grid of video/audio tiles plus a control bar. Kept separate
 * from the WebRTC logic in call.js so the mechanics and the presentation don't
 * tangle. call.js drives this via the hooks in Call.setUI(...).
 */
(() => {
  const $ = (id) => document.getElementById(id);
  let overlay, grid, incomingBox;

  function build() {
    if (overlay) return;
    overlay = document.createElement("div");
    overlay.id = "call-overlay";
    overlay.innerHTML = `
      <div id="call-grid"></div>
      <div id="call-bar">
        <button id="call-mic" class="call-btn" title="Mute / unmute">
          <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/></svg>
        </button>
        <button id="call-cam" class="call-btn" title="Camera on / off">
          <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>
        </button>
        <button id="call-end" class="call-btn end" title="Leave call">
          <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.68 13.31a16 16 0 0 0 3.41 2.6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7 2 2 0 0 1 1.72 2v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.42 19.42 0 0 1-3.33-2.67m-2.67-3.34a19.79 19.79 0 0 1-3.07-8.66A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91"/><line x1="23" y1="1" x2="1" y2="23"/></svg>
        </button>
      </div>`;
    document.body.appendChild(overlay);
    grid = $("call-grid");
    $("call-mic").onclick = () => { const on = Call.toggleMic(); $("call-mic").classList.toggle("off", !on); };
    $("call-cam").onclick = () => { const on = Call.toggleCam(); $("call-cam").classList.toggle("off", !on); };
    $("call-end").onclick = () => Call.hangup();
  }

  function tile(id, label, muted) {
    let t = document.getElementById("tile-" + id);
    if (!t) {
      t = document.createElement("div"); t.className = "call-tile"; t.id = "tile-" + id;
      const v = document.createElement("video"); v.autoplay = true; v.playsInline = true; if (muted) v.muted = true;
      const n = document.createElement("div"); n.className = "call-name"; n.textContent = label;
      t.append(v, n); grid.appendChild(t);
    }
    return t;
  }

  const ui = {
    open(video) { build(); overlay.classList.add("show"); overlay.classList.toggle("has-video", video); },
    close() { if (overlay) { overlay.classList.remove("show"); if (grid) grid.innerHTML = ""; } removeIncoming(); },
    addLocal(stream, name, video) {
      const t = tile("local", name + " (you)", true);   // mute own tile: no echo
      t.querySelector("video").srcObject = stream;
      t.classList.toggle("audio-only", !video);
    },
    addRemote(peerId, stream, name) {
      const t = tile(peerId, name || "Guest", false);
      const v = t.querySelector("video"); v.srcObject = stream;
      // if the remote has no video track, show an audio-only tile
      const hasVideo = stream.getVideoTracks().length > 0;
      t.classList.toggle("audio-only", !hasVideo);
    },
    removeRemote(peerId) { const t = document.getElementById("tile-" + peerId); if (t) t.remove(); },
    checkEmpty() { /* mesh: staying in the call alone is fine, they may rejoin */ },
    error(msg) { if (window.__toast) window.__toast(msg); else alert(msg); },
    // An incoming-call banner when someone starts a call and you're not in it yet.
    incoming(from, name) {
      removeIncoming();
      incomingBox = document.createElement("div");
      incomingBox.id = "call-incoming";
      incomingBox.innerHTML = `<span>📞 ${escapeHtml(name || "Someone")} started a call</span>
        <button id="call-join">Join</button><button id="call-dismiss">Dismiss</button>`;
      document.body.appendChild(incomingBox);
      document.getElementById("call-join").onclick = () => { removeIncoming(); Call.start(false); };
      document.getElementById("call-dismiss").onclick = removeIncoming;
    },
  };
  function removeIncoming() { if (incomingBox) { incomingBox.remove(); incomingBox = null; } }
  function escapeHtml(s) { const d = document.createElement("div"); d.textContent = s; return d.innerHTML; }

  Call.setUI(ui);
})();

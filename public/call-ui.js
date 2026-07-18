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
      <div id="call-top">
        <button id="call-min" title="Back to chat (stay in call)" aria-label="Minimize call">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/><line x1="14" y1="10" x2="21" y2="3"/><line x1="3" y1="21" x2="10" y2="14"/></svg>
          <span>Chat</span>
        </button>
        <span id="call-title">On call</span>
      </div>
      <div id="call-grid"></div>
      <div id="call-bar">
        <button id="call-mic" class="call-btn" title="Mute / unmute" aria-label="Mute or unmute">
          <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/></svg>
        </button>
        <button id="call-cam" class="call-btn" title="Camera on / off" aria-label="Camera on or off">
          <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>
        </button>
        <button id="call-end" class="call-btn end" title="Leave call" aria-label="Leave call">
          <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.68 13.31a16 16 0 0 0 3.41 2.6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7 2 2 0 0 1 1.72 2v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.42 19.42 0 0 1-3.33-2.67m-2.67-3.34a19.79 19.79 0 0 1-3.07-8.66A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91"/><line x1="23" y1="1" x2="1" y2="23"/></svg>
        </button>
      </div>`;
    document.body.appendChild(overlay);
    grid = $("call-grid");
    $("call-mic").onclick = () => { const on = Call.toggleMic(); $("call-mic").classList.toggle("off", !on); };
    $("call-cam").onclick = () => { const on = Call.toggleCam(); $("call-cam").classList.toggle("off", !on); };
    $("call-end").onclick = () => Call.hangup();
    $("call-min").onclick = () => ui.minimize();
    // Floating pill shown while minimized, to jump back into the call.
    if (!document.getElementById("call-pill")) {
      const pill = document.createElement("button");
      pill.id = "call-pill"; pill.innerHTML = `<span class="dot on"></span> On call — tap to return`;
      pill.onclick = () => ui.maximize();
      document.body.appendChild(pill);
    }
  }

  function tile(id, label, muted) {
    let t = document.getElementById("tile-" + id);
    if (!t) {
      t = document.createElement("div"); t.className = "call-tile"; t.id = "tile-" + id;
      const v = document.createElement("video"); v.autoplay = true; v.playsInline = true; if (muted) v.muted = true;
      const n = document.createElement("div"); n.className = "call-name"; n.textContent = label;
      const s = document.createElement("div"); s.className = "call-status"; s.textContent = id === "local" ? "" : "Connecting…";
      t.append(v, n, s); grid.appendChild(t);
    }
    return t;
  }

  const ui = {
    open(video) { build(); overlay.classList.remove("min"); overlay.classList.add("show"); overlay.classList.toggle("has-video", video); hidePill(); },
    // Hide the call to see the chat, keep the call running. A floating pill returns.
    minimize() { if (overlay) overlay.classList.add("min"); showPill(); },
    maximize() { if (overlay) overlay.classList.remove("min"); hidePill(); },
    // Caller feedback so they're not staring at just themselves wondering if it worked.
    waiting(othersInRoom) {
      const bar = $("call-hint") || (() => {
        const b = document.createElement("div"); b.id = "call-hint"; overlay.insertBefore(b, $("call-bar")); return b;
      })();
      bar.textContent = othersInRoom > 0
        ? `Ringing… waiting for ${othersInRoom} ${othersInRoom === 1 ? "person" : "people"} in the room to join`
        : "You're the only one here. Share the room link, then they can join your call.";
      bar.style.display = "block";
    },
    hideWaiting() { const b = $("call-hint"); if (b) b.style.display = "none"; },
    close() { if (overlay) { overlay.classList.remove("show", "min"); if (grid) grid.innerHTML = ""; } removeIncoming(); hidePill(); },
    addLocal(stream, name, video) {
      const t = tile("local", name + " (you)", true);   // mute own tile: no echo
      t.querySelector("video").srcObject = stream;
      t.classList.toggle("audio-only", !video);
    },
    addRemote(peerId, stream, name) {
      this.hideWaiting();
      const t = tile(peerId, name || "Guest", false);
      const v = t.querySelector("video"); v.srcObject = stream;
      // if the remote has no video track, show an audio-only tile
      const hasVideo = stream.getVideoTracks().length > 0;
      t.classList.toggle("audio-only", !hasVideo);
    },
    removeRemote(peerId) { const t = document.getElementById("tile-" + peerId); if (t) t.remove(); },
    peerStatus(peerId, state) {
      const t = document.getElementById("tile-" + peerId); if (!t) return;
      const s = t.querySelector(".call-status"); if (!s) return;
      if (state === "connected") { s.textContent = ""; t.classList.remove("failed"); }
      else if (state === "reconnecting") { s.textContent = "Reconnecting…"; }
      else if (state === "failed") { s.textContent = "Couldn't connect (network/firewall)"; t.classList.add("failed"); }
    },
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

  // A clear, actionable dialog when mic/camera access fails, with steps for the
  // user's actual device and a retry button.
  ui.permHelp = function (customMsg, wantedVideo) {
    let box = $("perm-help");
    if (box) box.remove();
    const isiOS = /iPhone|iPad|iPod/.test(navigator.userAgent);
    const isAndroid = /Android/.test(navigator.userAgent);
    const steps = isiOS
      ? "On iPhone: tap the <b>“aA”</b> icon in Safari's address bar → <b>Website Settings</b> → set Camera &amp; Microphone to <b>Allow</b>, then tap Retry. (Or Settings → Safari → Camera/Microphone.)"
      : isAndroid
      ? "On Android: tap the <b>lock/ⓘ icon</b> next to the address bar → <b>Permissions</b> → turn on Camera &amp; Microphone, then tap Retry."
      : "Click the <b>camera/lock icon</b> in your browser's address bar and set Camera &amp; Microphone to <b>Allow</b>, then tap Retry.";
    box = document.createElement("div");
    box.id = "perm-help";
    box.innerHTML = `
      <div class="perm-card">
        <div class="perm-title">Allow mic &amp; camera</div>
        <p class="perm-msg">${customMsg ? escapeHtml(customMsg) : "Your browser blocked access. To call, allow it:"}</p>
        ${customMsg ? "" : `<p class="perm-steps">${steps}</p>`}
        <div class="perm-actions">
          <button id="perm-retry">Retry</button>
          <button id="perm-close">Cancel</button>
        </div>
      </div>`;
    document.body.appendChild(box);
    document.getElementById("perm-close").onclick = () => box.remove();
    document.getElementById("perm-retry").onclick = () => { box.remove(); Call.start(!!wantedVideo); };
  };

  function showPill() { const p = $("call-pill"); if (p) p.classList.add("show"); }
  function hidePill() { const p = $("call-pill"); if (p) p.classList.remove("show"); }
  function escapeHtml(s) { const d = document.createElement("div"); d.textContent = s; return d.innerHTML; }

  Call.setUI(ui);
})();

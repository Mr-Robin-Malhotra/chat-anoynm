/*
 * Voice / video calling over WebRTC — mesh topology (every participant connects
 * directly to every other). Fine for small rooms (up to ~5-6 people), zero media
 * server, lowest latency.
 *
 * The existing WebSocket relay is reused as the SIGNALING channel: it already
 * forwards arbitrary JSON between peers, which is all SDP offers/answers and ICE
 * candidates need. Media itself flows peer-to-peer, never through the relay.
 *
 * Encryption note: WebRTC media is always encrypted in transit (mandatory
 * DTLS-SRTP). It's a different mechanism than the text chat's end-to-end
 * encryption, but calls are not sent in the clear.
 *
 * Signaling messages (piggybacked on the chat relay):
 *   { t:"call-invite", from, name, video }   -> someone started/joined a call
 *   { t:"call-offer",  from, to, sdp }
 *   { t:"call-answer", from, to, sdp }
 *   { t:"call-ice",    from, to, cand }
 *   { t:"call-leave",  from }
 */

const Call = (() => {
  // ICE servers. STUN alone connects people on simple networks; TURN relays
  // media for anyone behind a strict NAT/firewall (without it, some calls just
  // never connect — the usual "it says calling but nothing happens"). We list
  // several TURN transports: UDP is fastest, but TCP and TLS/443 punch through
  // almost any corporate firewall, so a call will fall back to whatever works.
  const ICE = {
    iceServers: [
      { urls: "stun:stun.l.google.com:19302" },
      { urls: "stun:stun1.l.google.com:19302" },
      { urls: "stun:stun.cloudflare.com:3478" },
      {
        urls: [
          "turn:openrelay.metered.ca:80",
          "turn:openrelay.metered.ca:443",
          "turn:openrelay.metered.ca:443?transport=tcp",
          "turns:openrelay.metered.ca:443?transport=tcp",
        ],
        username: "openrelayproject",
        credential: "openrelayproject",
      },
    ],
    iceCandidatePoolSize: 4,
  };

  let active = false;        // are we in a call?
  let withVideo = false;
  let localStream = null;
  const pcs = new Map();     // peerId -> RTCPeerConnection
  const remoteEls = new Map(); // peerId -> <video>/<audio> element

  // Hooks set by chat.js so this module can send signals and know the roster.
  let signal = () => {};     // (obj) => void   sends JSON via the relay
  let getMyId = () => "";
  let getName = () => "Anonymous";
  let getPeerName = () => "";

  function configure(opts) {
    signal = opts.signal; getMyId = opts.getMyId; getName = opts.getName; getPeerName = opts.getPeerName;
    if (opts.peerCount) peerCountHint = opts.peerCount;
  }

  let inviteTimer = null;

  // ---- starting / joining a call ----
  async function start(video) {
    if (active) return;
    try {
      localStream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: video ? { width: { ideal: 640 }, height: { ideal: 480 } } : false,
      });
    } catch (e) {
      ui.error(e && e.name === "NotAllowedError"
        ? "Please allow microphone/camera access to call."
        : "Couldn't access your microphone/camera.");
      return;
    }
    active = true; withVideo = video;
    ui.open(video);
    ui.addLocal(localStream, getName(), video);

    // Announce we're in the call, and KEEP announcing every 2s (like a ringing
    // phone) so anyone in the room — including someone who has the tab open but
    // just reconnected — reliably gets the invite. Stops once someone connects.
    const invite = () => signal({ t: "call-invite", from: getMyId(), name: getName(), video });
    invite();
    clearInterval(inviteTimer);
    inviteTimer = setInterval(() => {
      if (pcs.size > 0) { clearInterval(inviteTimer); inviteTimer = null; }
      else invite();
    }, 2000);

    // Let the caller know what's going on instead of staring at themselves.
    ui.waiting(peerCountHint());
  }

  // Rough count of who else is in the room (set by chat.js via a hook).
  let peerCountHint = () => 0;

  // Someone announced they're in the call (a newcomer). Everyone already in the
  // call offers to the newcomer; the newcomer just answers. This avoids glare
  // (both sides offering at once) without any id-comparison guesswork.
  async function onInvite(from) {
    if (!active) { ui.incoming(from, getPeerName(from)); return; }
    if (pcs.has(from)) return;              // already connecting to them
    await makeOffer(from);                  // I'm already in the call -> I offer
  }

  // Per-peer ICE candidate queue. Candidates can arrive before we've called
  // setRemoteDescription; adding them then throws and the connection silently
  // never forms (the classic real-world WebRTC bug). So we buffer them and flush
  // once the remote description is set.
  const iceQueue = new Map();  // peerId -> [candidates]

  function newPeer(peerId) {
    const pc = new RTCPeerConnection(ICE);
    pcs.set(peerId, pc);
    pc.hasRemote = false;
    for (const track of localStream.getTracks()) pc.addTrack(track, localStream);
    pc.onicecandidate = (e) => {
      if (e.candidate) signal({ t: "call-ice", from: getMyId(), to: peerId, cand: e.candidate });
    };
    pc.ontrack = (e) => { log(peerId, "track received"); ui.addRemote(peerId, e.streams[0], getPeerName(peerId)); };
    pc.oniceconnectionstatechange = () => {
      log(peerId, "ice=" + pc.iceConnectionState);
      if (pc.iceConnectionState === "failed") { try { pc.restartIce(); } catch {} }
    };
    pc.onconnectionstatechange = () => {
      log(peerId, "conn=" + pc.connectionState);
      const st = pc.connectionState;
      if (st === "connected") { clearTimeout(pc.failTimer); ui.peerStatus(peerId, "connected"); }
      if (["failed", "closed"].includes(st)) dropPeer(peerId);
      if (st === "disconnected") ui.peerStatus(peerId, "reconnecting");
    };
    // If a peer hasn't connected within 20s, tell the user (usually a NAT/TURN
    // problem) instead of leaving them staring at a silent "calling…" tile.
    pc.failTimer = setTimeout(() => {
      if (pc.connectionState !== "connected") {
        ui.peerStatus(peerId, "failed");
        log(peerId, "connect timeout");
      }
    }, 20000);
    return pc;
  }

  async function flushIce(peerId, pc) {
    const q = iceQueue.get(peerId);
    if (q) { iceQueue.delete(peerId); for (const c of q) { try { await pc.addIceCandidate(c); } catch {} } }
  }

  async function makeOffer(peerId) {
    log(peerId, "making offer");
    const pc = newPeer(peerId);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    signal({ t: "call-offer", from: getMyId(), to: peerId, sdp: pc.localDescription });
  }

  async function onOffer(from, sdp) {
    if (!active) return;                 // ignore offers when not in a call
    log(from, "got offer");
    let pc = pcs.get(from) || newPeer(from);
    await pc.setRemoteDescription(sdp);
    pc.hasRemote = true;
    await flushIce(from, pc);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    signal({ t: "call-answer", from: getMyId(), to: from, sdp: pc.localDescription });
  }

  async function onAnswer(from, sdp) {
    const pc = pcs.get(from);
    if (!pc) return;
    log(from, "got answer");
    await pc.setRemoteDescription(sdp);
    pc.hasRemote = true;
    await flushIce(from, pc);
  }

  async function onIce(from, cand) {
    const pc = pcs.get(from);
    if (pc && pc.hasRemote) { try { await pc.addIceCandidate(cand); } catch {} }
    else { if (!iceQueue.has(from)) iceQueue.set(from, []); iceQueue.get(from).push(cand); }
  }

  function dropPeer(peerId) {
    const pc = pcs.get(peerId);
    if (pc) { try { pc.close(); } catch {} pcs.delete(peerId); }
    iceQueue.delete(peerId);
    ui.removeRemote(peerId);
  }

  function log(peerId, msg) {
    if (window.__CALL_DEBUG) console.log("[call " + String(peerId).slice(0, 4) + "] " + msg);
  }

  function hangup() {
    if (!active) return;
    active = false;
    clearInterval(inviteTimer); inviteTimer = null;
    signal({ t: "call-leave", from: getMyId() });
    for (const id of pcs.keys()) dropPeer(id);
    if (localStream) { localStream.getTracks().forEach((t) => t.stop()); localStream = null; }
    ui.close();
  }

  // A peer left the call or the room.
  function onLeave(from) { dropPeer(from); ui.checkEmpty(); }

  // ---- mic / camera toggles ----
  function toggleMic() {
    if (!localStream) return false;
    const t = localStream.getAudioTracks()[0];
    if (t) { t.enabled = !t.enabled; return t.enabled; }
    return false;
  }
  function toggleCam() {
    if (!localStream) return false;
    const t = localStream.getVideoTracks()[0];
    if (t) { t.enabled = !t.enabled; return t.enabled; }
    return false;
  }

  const inCall = () => active;

  // ---- route a signaling message from the relay ----
  function handle(m) {
    switch (m.t) {
      case "call-invite": onInvite(m.from); return true;
      case "call-offer":  if (m.to === getMyId()) onOffer(m.from, m.sdp); return true;
      case "call-answer": if (m.to === getMyId()) onAnswer(m.from, m.sdp); return true;
      case "call-ice":    if (m.to === getMyId()) onIce(m.from, m.cand); return true;
      case "call-leave":  onLeave(m.from); return true;
    }
    return false;
  }

  // UI hooks are provided by call-ui.js
  let ui = {};
  function setUI(u) { ui = u; }

  return { configure, setUI, start, hangup, toggleMic, toggleCam, inCall, handle,
           _accept: (from) => start(false) };
})();

window.Call = Call;

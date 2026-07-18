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
  const ICE = {
    iceServers: [
      { urls: "stun:stun.l.google.com:19302" },
      { urls: "stun:stun1.l.google.com:19302" },
      // Free community TURN (helps peers behind strict NATs connect). If a call
      // won't connect for someone, this is usually why; a paid TURN is more
      // reliable but costs money.
      {
        urls: "turn:openrelay.metered.ca:80",
        username: "openrelayproject",
        credential: "openrelayproject",
      },
    ],
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
  }

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
        ? "Microphone/camera permission denied."
        : "Couldn't access your microphone/camera.");
      return;
    }
    active = true; withVideo = video;
    ui.open(video);
    ui.addLocal(localStream, getName(), video);
    // Tell the room we're in the call so existing members offer to us.
    signal({ t: "call-invite", from: getMyId(), name: getName(), video });
  }

  // Someone announced they're in the call (a newcomer). Everyone already in the
  // call offers to the newcomer; the newcomer just answers. This avoids glare
  // (both sides offering at once) without any id-comparison guesswork.
  async function onInvite(from) {
    if (!active) { ui.incoming(from, getPeerName(from)); return; }
    if (pcs.has(from)) return;              // already connecting to them
    await makeOffer(from);                  // I'm already in the call -> I offer
  }

  function newPeer(peerId) {
    const pc = new RTCPeerConnection(ICE);
    pcs.set(peerId, pc);
    for (const track of localStream.getTracks()) pc.addTrack(track, localStream);
    pc.onicecandidate = (e) => {
      if (e.candidate) signal({ t: "call-ice", from: getMyId(), to: peerId, cand: e.candidate });
    };
    pc.ontrack = (e) => ui.addRemote(peerId, e.streams[0], getPeerName(peerId));
    pc.onconnectionstatechange = () => {
      if (["failed", "closed", "disconnected"].includes(pc.connectionState)) dropPeer(peerId);
    };
    return pc;
  }

  async function makeOffer(peerId) {
    const pc = newPeer(peerId);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    signal({ t: "call-offer", from: getMyId(), to: peerId, sdp: pc.localDescription });
  }

  async function onOffer(from, sdp) {
    if (!active) return;                 // ignore offers when not in a call
    let pc = pcs.get(from) || newPeer(from);
    await pc.setRemoteDescription(sdp);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    signal({ t: "call-answer", from: getMyId(), to: from, sdp: pc.localDescription });
  }

  async function onAnswer(from, sdp) {
    const pc = pcs.get(from);
    if (pc) await pc.setRemoteDescription(sdp);
  }

  async function onIce(from, cand) {
    const pc = pcs.get(from);
    if (pc) { try { await pc.addIceCandidate(cand); } catch {} }
  }

  function dropPeer(peerId) {
    const pc = pcs.get(peerId);
    if (pc) { try { pc.close(); } catch {} pcs.delete(peerId); }
    ui.removeRemote(peerId);
  }

  function hangup() {
    if (!active) return;
    active = false;
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

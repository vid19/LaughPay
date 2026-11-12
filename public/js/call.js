// Built-in 1:1 video call. The creator is always the one who places the call
// (sends the offer); the caller answers. Messages go through the LaughPay server,
// video and audio flow directly between the two browsers (WebRTC).

let iceServersPromise;
function iceServers() {
  iceServersPromise ||= fetch('/api/config')
    .then((r) => r.json())
    .then((c) => c.iceServers || [{ urls: 'stun:stun.l.google.com:19302' }])
    .catch(() => [{ urls: 'stun:stun.l.google.com:19302' }]);
  return iceServersPromise;
}

const CALL_MEDIA = {
  video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' },
  audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
};

class Peer {
  constructor({ onTrack, onState, sendSignal, localStream }) {
    this.onTrack = onTrack;
    this.onState = onState;
    this.sendSignal = sendSignal;
    this.localStream = localStream;
    this.pending = []; // ICE candidates that arrive before the remote description
  }

  async init() {
    this.pc = new RTCPeerConnection({ iceServers: await iceServers() });
    for (const t of this.localStream.getTracks()) this.pc.addTrack(t, this.localStream);
    this.pc.ontrack = (e) => this.onTrack(e.streams[0]);
    this.pc.onicecandidate = (e) => e.candidate && this.sendSignal('ice', e.candidate.toJSON());
    this.pc.onconnectionstatechange = () => this.onState(this.pc.connectionState);
  }

  async addIce(candidate) {
    if (!this.pc.remoteDescription) return this.pending.push(candidate);
    await this.pc.addIceCandidate(candidate).catch(() => {});
  }

  async flushIce() {
    for (const c of this.pending.splice(0)) await this.pc.addIceCandidate(c).catch(() => {});
  }

  close() {
    this.pc?.close();
    this.pc = null;
  }
}

async function post(cid, body, creatorKey) {
  const headers = { 'Content-Type': 'application/json' };
  if (creatorKey) headers['x-creator-key'] = creatorKey;
  const res = await fetch(`/api/challenges/${cid}/call/signal`, { method: 'POST', headers, body: JSON.stringify(body), credentials: 'same-origin' });
  if (!res.ok && res.status !== 409) console.warn('signal failed', res.status);
}

/** Creator side: calls whichever caller is live. */
export class CallHost {
  constructor({ cid, creatorKey, remoteVideo, onState = () => {} }) {
    Object.assign(this, { cid, creatorKey, remoteVideo, onState });
    this.entryId = null;
    this.peer = null;
  }

  async connect() {
    const res = await fetch(`/api/challenges/${this.cid}/call/token`, { method: 'POST', headers: { 'x-creator-key': this.creatorKey } });
    const { token } = await res.json();
    this.es = new EventSource(`/api/challenges/${this.cid}/call/events?token=${encodeURIComponent(token)}`);
    this.es.onmessage = (e) => this.handle(JSON.parse(e.data)).catch((err) => console.warn('call', err));
    this.es.onopen = () => this.entryId && this.send('hello');
  }

  async ensureMedia() {
    this.localStream ||= await navigator.mediaDevices.getUserMedia(CALL_MEDIA);
    return this.localStream;
  }

  send(type, data = null) {
    return post(this.cid, { type, data, entryId: this.entryId }, this.creatorKey);
  }

  /** Called on every dashboard refresh with the live queue entry (or null). */
  setLiveEntry(entryId) {
    if (entryId === this.entryId) return;
    this.hangup(false);
    this.entryId = entryId;
    if (entryId) {
      this.onState('waiting');
      this.send('hello'); // asks the caller to say "ready" once their camera is on
    } else {
      this.onState('idle');
    }
  }

  async handle(msg) {
    if (msg.entryId !== this.entryId) return; // a message about a previous caller
    if (msg.type === 'ready') return this.placeCall();
    if (!this.peer) return;
    if (msg.type === 'answer') {
      await this.peer.pc.setRemoteDescription(msg.data);
      await this.peer.flushIce();
    } else if (msg.type === 'ice') {
      await this.peer.addIce(msg.data);
    } else if (msg.type === 'hangup') {
      this.hangup(false);
      this.onState('waiting');
    }
  }

  async placeCall() {
    this.hangup(false);
    this.onState('connecting');
    const stream = await this.ensureMedia();
    const peer = new Peer({
      localStream: stream,
      sendSignal: (type, data) => this.send(type, data),
      onTrack: (s) => {
        this.remoteVideo.srcObject = s;
        this.remoteVideo.play().catch(() => {});
      },
      onState: (st) => this.onState(st === 'connected' ? 'connected' : st === 'failed' ? 'failed' : st === 'disconnected' ? 'reconnecting' : 'connecting'),
    });
    await peer.init();
    this.peer = peer;
    const offer = await peer.pc.createOffer();
    await peer.pc.setLocalDescription(offer);
    await this.send('offer', peer.pc.localDescription.toJSON());
  }

  hangup(notify = true) {
    if (notify && this.peer) this.send('hangup');
    this.peer?.close();
    this.peer = null;
    this.remoteVideo.srcObject = null;
  }
}

/** Caller side: joins when it is their turn. */
export class CallGuest {
  constructor({ cid, localVideo, remoteVideo, onState = () => {} }) {
    Object.assign(this, { cid, localVideo, remoteVideo, onState });
    this.entryId = null;
    this.peer = null;
    this.stream = null;
    this.earlyIce = []; // candidates that overtake the offer on the way here
  }

  async join(entryId) {
    this.entryId = entryId;
    this.onState('starting');
    this.stream ||= await navigator.mediaDevices.getUserMedia(CALL_MEDIA);
    this.localVideo.srcObject = this.stream;
    this.localVideo.muted = true;
    this.localVideo.play().catch(() => {});
    if (!this.es) {
      this.es = new EventSource(`/api/challenges/${this.cid}/call/events`, { withCredentials: true });
      this.es.onmessage = (e) => this.handle(JSON.parse(e.data)).catch((err) => console.warn('call', err));
      this.es.onopen = () => this.entryId && this.send('ready');
    } else {
      this.send('ready');
    }
    this.onState('waiting');
  }

  send(type, data = null) {
    return post(this.cid, { type, data, entryId: this.entryId });
  }

  async handle(msg) {
    if (msg.type === 'hangup') return this.leave();
    if (msg.entryId !== this.entryId) return;
    if (msg.type === 'hello' && this.stream) return this.send('ready');
    if (msg.type === 'offer') {
      this.peer?.close();
      this.onState('connecting');
      this.peer = new Peer({
        localStream: this.stream,
        sendSignal: (type, data) => this.send(type, data),
        onTrack: (s) => {
          this.remoteVideo.srcObject = s;
          this.remoteVideo.play().catch(() => {});
        },
        onState: (st) => this.onState(st === 'connected' ? 'connected' : st === 'failed' ? 'failed' : 'connecting'),
      });
      await this.peer.init();
      this.peer.pending.push(...this.earlyIce.splice(0));
      await this.peer.pc.setRemoteDescription(msg.data);
      await this.peer.flushIce();
      const answer = await this.peer.pc.createAnswer();
      await this.peer.pc.setLocalDescription(answer);
      await this.send('answer', this.peer.pc.localDescription.toJSON());
    } else if (msg.type === 'ice') {
      if (this.peer) await this.peer.addIce(msg.data);
      else this.earlyIce.push(msg.data);
    }
  }

  leave() {
    this.earlyIce = [];
    this.peer?.close();
    this.peer = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.remoteVideo.srcObject = null;
    this.localVideo.srcObject = null;
    this.entryId = null;
    this.onState('ended');
  }
}

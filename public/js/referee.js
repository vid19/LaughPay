// On-device laugh detector for the AI referee. Runs entirely in the creator's browser:
// video and audio never leave the machine. It only reports numbers, plus one small
// snapshot when a laugh is detected.
//
//  face  = MediaPipe Face Landmarker blendshapes (smile, open jaw, squinting eyes),
//          measured relative to the creator's own calibrated "straight face"
//  audio = YAMNet audio classifier, laughter-family classes only
//  score = smoothed blend of the two; a laugh fires when it stays above the
//          threshold for SUSTAIN_MS, so a quick smirk or a cough does not count.

const LAUGH_CLASSES = ['Laughter', 'Baby laughter', 'Giggle', 'Snicker', 'Belly laugh', 'Chuckle, chortle'];
const CALIBRATION_MS = 5000;
const SUSTAIN_MS = 600; // must stay above the threshold this long
const MAX_RUN_MS = 1500; // report a long laugh after this much, without waiting for it to end
const COOLDOWN_MS = 4000;
const clamp = (n) => Math.max(0, Math.min(1, n));
const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

export class LaughDetector {
  constructor({ video, onTick = () => {}, onStatus = () => {}, onLaugh = () => {} }) {
    this.video = video;
    this.onTick = onTick;
    this.onStatus = onStatus;
    this.onLaugh = onLaugh;
    this.threshold = 0.55;
    this.state = 'off'; // off | loading | calibrating | armed | error
    this.face = 0;
    this.audioRaw = 0;
    this.audio = 0;
    this.score = 0;
    this.faceFound = false;
    this.baseline = { smile: 0.05, jaw: 0.05, squint: 0.1, audio: 0 };
    this.timeline = [];
    this.run = null; // current above-threshold run
    this.lastFire = 0;
    this.simUntil = 0;
    this.useMic = false;
    this._lastVideoTime = -1;
    this._lastSample = 0;
    requestAnimationFrame((t) => this._loop(t));
  }

  setStatus(state, detail = '') {
    this.state = state;
    this.onStatus(state, detail);
  }

  async start({ useMic = true } = {}) {
    this.setStatus('loading', 'Starting camera…');
    this.useMic = useMic;
    // Browsers only let audio start right after a click, so create it now, before the slow model loads.
    if (useMic) {
      this.audioCtx = new AudioContext();
      this.audioCtx.resume().catch(() => {});
    }
    this.stream = await navigator.mediaDevices.getUserMedia({
      video: { width: 640, height: 480, facingMode: 'user' },
      // Echo cancellation and noise suppression are tuned for speech and squash laughter, so they stay off.
      // The face gate below keeps the caller's laughter from the speakers from firing on its own.
      audio: useMic ? { echoCancellation: false, noiseSuppression: false, autoGainControl: true } : false,
    });
    this.video.srcObject = this.stream;
    this.video.muted = true;
    await this.video.play();

    this.setStatus('loading', 'Loading face model…');
    const vision = await import('/vendor/tasks-vision/vision_bundle.mjs');
    const vfs = await vision.FilesetResolver.forVisionTasks('/vendor/tasks-vision/wasm');
    const faceOpts = (delegate) => ({
      baseOptions: { modelAssetPath: '/models/face_landmarker.task', delegate },
      runningMode: 'VIDEO',
      numFaces: 1,
      outputFaceBlendshapes: true,
    });
    try {
      this.landmarker = await vision.FaceLandmarker.createFromOptions(vfs, faceOpts('GPU'));
    } catch {
      this.landmarker = await vision.FaceLandmarker.createFromOptions(vfs, faceOpts('CPU'));
    }

    if (useMic) {
      this.setStatus('loading', 'Loading laughter audio model…');
      const audio = await import('/vendor/tasks-audio/audio_bundle.mjs');
      const afs = await audio.FilesetResolver.forAudioTasks('/vendor/tasks-audio/wasm');
      this.classifier = await audio.AudioClassifier.createFromOptions(afs, {
        baseOptions: { modelAssetPath: '/models/yamnet.tflite' },
        maxResults: LAUGH_CLASSES.length,
        categoryAllowlist: LAUGH_CLASSES,
      });
      this._startAudio();
    }

    this.calibrate();
  }

  _startAudio() {
    const ctx = this.audioCtx || new AudioContext();
    this.audioCtx = ctx;
    if (ctx.state !== 'running') ctx.resume().catch(() => {});
    const src = ctx.createMediaStreamSource(this.stream);
    const proc = ctx.createScriptProcessor(4096, 1, 1);
    const silent = ctx.createGain();
    silent.gain.value = 0; // keeps the processor running without playing the mic back
    const ring = new Float32Array(ctx.sampleRate * 2); // last 2 seconds
    let pos = 0;
    proc.onaudioprocess = (e) => {
      const input = e.inputBuffer.getChannelData(0);
      let sq = 0;
      for (let i = 0; i < input.length; i++) sq += input[i] * input[i];
      // Mic loudness (0..1, roughly) so the dashboard can show sound is coming through.
      this.micLevel = Math.min(1, Math.sqrt(sq / input.length) * 8);
      for (let i = 0; i < input.length; i++) {
        ring[pos] = input[i];
        pos = (pos + 1) % ring.length;
      }
    };
    src.connect(proc);
    proc.connect(silent);
    silent.connect(ctx.destination);
    this.audioFrames = 0;
    proc.addEventListener('audioprocess', () => (this.audioFrames += 1));
    this._audioTimer = setInterval(() => {
      if (ctx.state !== 'running') ctx.resume().catch(() => {});
      const ordered = new Float32Array(ring.length);
      ordered.set(ring.subarray(pos));
      ordered.set(ring.subarray(0, pos), ring.length - pos);
      try {
        // YAMNet scores ~1 s slices; take the strongest laughter score across all of them
        // (the last slice is often a short, mostly silent remainder).
        const results = this.classifier.classify(ordered, ctx.sampleRate);
        let best = 0;
        for (const r of results) {
          for (const c of r.classifications?.[0]?.categories || []) best = Math.max(best, c.score);
        }
        // Hold the strongest reading from the last second so short bursts are not missed.
        const t = performance.now();
        this._audioHist = (this._audioHist || []).filter((h) => t - h.t < 1000);
        this._audioHist.push({ t, v: best });
        this.audioRaw = Math.max(...this._audioHist.map((h) => h.v));
      } catch (err) {
        console.warn('audio classify', err);
      }
    }, 250);
  }

  calibrate() {
    this._calib = { until: performance.now() + CALIBRATION_MS, smile: [], jaw: [], squint: [], audio: [] };
    this.setStatus('calibrating', 'Keep a straight face for 5 seconds…');
  }

  simulate(ms = 1400) {
    this.simUntil = performance.now() + ms;
  }

  stop() {
    clearInterval(this._audioTimer);
    this.audioCtx?.close();
    this.stream?.getTracks().forEach((t) => t.stop());
    this.landmarker?.close?.();
    this.classifier?.close?.();
    this.landmarker = this.classifier = null;
    this.setStatus('off');
  }

  snapshot() {
    const c = document.createElement('canvas');
    c.width = 320;
    c.height = 240;
    const g = c.getContext('2d');
    if (this.video.readyState >= 2 && this.stream) {
      g.drawImage(this.video, 0, 0, c.width, c.height);
    } else {
      g.fillStyle = '#17151f';
      g.fillRect(0, 0, c.width, c.height);
      g.fillStyle = '#ffd23f';
      g.font = 'bold 22px sans-serif';
      g.fillText('Simulated laugh', 70, 125);
    }
    return c.toDataURL('image/jpeg', 0.72);
  }

  _readFace(now) {
    if (!this.landmarker || this.video.readyState < 2 || this.video.currentTime === this._lastVideoTime) return null;
    this._lastVideoTime = this.video.currentTime;
    const res = this.landmarker.detectForVideo(this.video, now);
    const cats = res.faceBlendshapes?.[0]?.categories;
    if (!cats) return { found: false };
    const b = Object.fromEntries(cats.map((c) => [c.categoryName, c.score]));
    return {
      found: true,
      smile: ((b.mouthSmileLeft || 0) + (b.mouthSmileRight || 0)) / 2,
      jaw: b.jawOpen || 0,
      squint: ((b.eyeSquintLeft || 0) + (b.eyeSquintRight || 0)) / 2,
    };
  }

  _loop(now) {
    requestAnimationFrame((t) => this._loop(t));
    let raw = 0;

    let f = null;
    try {
      f = this._readFace(now);
    } catch (err) {
      console.warn('face detect', err);
    }
    if (f) this.faceFound = f.found;

    // Calibration: learn this creator's neutral face and room noise.
    if (this._calib && f?.found) {
      this._calib.smile.push(f.smile);
      this._calib.jaw.push(f.jaw);
      this._calib.squint.push(f.squint);
      this._calib.audio.push(this.audioRaw);
    }
    if (this._calib && now >= this._calib.until) {
      const k = this._calib;
      this._calib = null;
      if (k.smile.length < 10) {
        this.calibrate();
        this.onStatus('calibrating', 'No face found yet. Look at the camera…');
      } else {
        this.baseline = { smile: avg(k.smile), jaw: avg(k.jaw), squint: avg(k.squint), audio: avg(k.audio) };
        this.setStatus('armed', 'Watching for laughs');
      }
    }

    if (f?.found) {
      const b = this.baseline;
      const s = clamp((f.smile - b.smile) / Math.max(0.25, 0.85 - b.smile));
      const j = clamp((f.jaw - b.jaw) / 0.45);
      const q = clamp((f.squint - b.squint) / 0.45);
      this.face = clamp(0.6 * s + 0.25 * j + 0.15 * q);
    } else if (f && !f.found) {
      this.face *= 0.85;
    }
    // A YAMNet laughter score around 0.3 is already a clear laugh, so it maps to near full strength.
    this.audio = this.useMic ? clamp((this.audioRaw - this.baseline.audio) / Math.max(0.15, 0.35 - this.baseline.audio)) : 0;

    if (this.state === 'armed') {
      raw = this.useMic ? 0.65 * this.face + 0.35 * this.audio : this.face;
      // The creator's own face must be in it: laughter from the speakers alone never fires.
      if (this.face < 0.25) raw = Math.min(raw, 0.3);
    }

    const simulating = now < this.simUntil;
    if (simulating) raw = 0.9 + Math.random() * 0.06;

    this.score += (raw - this.score) * 0.35;
    if (now - this._lastSample >= 100) {
      this._lastSample = now;
      this.timeline.push(Math.round(this.score * 100) / 100);
      if (this.timeline.length > 30) this.timeline.shift();
    }

    this._trigger(now, simulating);
    this.onTick({
      score: this.score,
      face: this.face,
      audio: this.audio,
      audioRaw: this.audioRaw,
      micLevel: this.micLevel || 0,
      audioOk: !this.useMic || (this.audioCtx?.state === 'running' && this.audioFrames > 0),
      faceFound: this.faceFound,
      threshold: this.threshold,
      simulating,
    });
  }

  _trigger(now, simulating) {
    const above = this.score >= this.threshold;
    if (above && now - this.lastFire >= COOLDOWN_MS) {
      if (!this.run) this.run = { start: now, peak: 0, sum: 0, n: 0, face: 0, audio: 0, snap: null, snapAt: 0 };
      const r = this.run;
      r.sum += this.score;
      r.n += 1;
      if (this.score > r.peak) {
        r.peak = this.score;
        r.face = simulating ? 0.9 : this.face;
        r.audio = simulating ? 0.8 : this.audio;
        if (now - r.snapAt > 150) {
          r.snap = this.snapshot(); // keep the frame closest to the peak
          r.snapAt = now;
        }
      }
      if (now - r.start >= MAX_RUN_MS) this._fire(now, simulating);
      return;
    }
    // Score dropped: it counts only if it stayed up long enough.
    if (this.run && now - this.run.start >= SUSTAIN_MS) this._fire(now, simulating);
    this.run = null;
  }

  _fire(now, simulating) {
    const r = this.run;
    this.run = null;
    this.lastFire = now;
    this.onLaugh({
      peak: r.peak,
      avg: r.sum / r.n,
      durationMs: Math.round(now - r.start),
      face: r.face,
      audio: r.audio,
      threshold: this.threshold,
      timeline: [...this.timeline],
      snapshot: r.snap || this.snapshot(),
      simulated: simulating || now - this.simUntil < 300,
    });
  }
}

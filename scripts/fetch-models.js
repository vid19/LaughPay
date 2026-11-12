// Downloads the two on-device models the AI referee uses into public/models/.
// Runs automatically after `npm install`; safe to re-run (skips files already present).
//   npm run setup:models
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'models');

const MODELS = [
  {
    file: 'face_landmarker.task',
    url: 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
  },
  {
    file: 'yamnet.tflite',
    url: 'https://storage.googleapis.com/mediapipe-models/audio_classifier/yamnet/float32/1/yamnet.tflite',
  },
];

fs.mkdirSync(dir, { recursive: true });
let failed = false;

for (const m of MODELS) {
  const dest = path.join(dir, m.file);
  if (fs.existsSync(dest) && fs.statSync(dest).size > 100_000) {
    console.log(`  ✓ ${m.file} already present`);
    continue;
  }
  try {
    process.stdout.write(`  ↓ ${m.file} … `);
    const res = await fetch(m.url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(dest, buf);
    console.log(`${(buf.length / 1e6).toFixed(1)} MB`);
  } catch (err) {
    failed = true;
    console.log(`failed (${err.message})`);
  }
}

if (failed) {
  console.warn('\n  Some models could not be downloaded. The AI referee needs them; run "npm run setup:models" again when online.');
  console.warn('  Everything else in LaughPay works without them.\n');
}

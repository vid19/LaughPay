// Tiny JSON-file store. Good enough for a single-process hackathon build;
// every write is flushed to disk atomically (write temp file, then rename).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';

const file = path.resolve(config.dataFile);
const EMPTY = { challenges: [], viewers: [], queue: [], judgeEvents: [], payouts: [], webhookLog: [], laughEvents: [] };

function load() {
  try {
    return { ...structuredClone(EMPTY), ...JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch {
    return structuredClone(EMPTY);
  }
}

let state = load();

function save() {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, file);
}

export function newId(bytes = 5) {
  return crypto.randomBytes(bytes).toString('hex');
}

const now = () => new Date().toISOString();

export const db = {
  all(coll) {
    return state[coll];
  },
  byId(coll, id) {
    return state[coll].find((r) => r.id === id) || null;
  },
  find(coll, pred) {
    return state[coll].find(pred) || null;
  },
  filter(coll, pred) {
    return state[coll].filter(pred);
  },
  insert(coll, row) {
    const rec = { id: newId(), createdAt: now(), ...row };
    state[coll].push(rec);
    save();
    return rec;
  },
  update(coll, id, patch) {
    const rec = state[coll].find((r) => r.id === id);
    if (!rec) return null;
    Object.assign(rec, patch, { updatedAt: now() });
    save();
    return rec;
  },
  reset() {
    state = structuredClone(EMPTY);
    save();
  },
};

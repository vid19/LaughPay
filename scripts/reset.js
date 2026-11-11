// Wipes local LaughPay data. Stop the server first, or it will write its in-memory copy back.
import fs from 'node:fs';
import path from 'node:path';
import 'dotenv/config';

const file = path.resolve(process.env.DATA_FILE || 'data/db.json');
fs.rmSync(file, { force: true });
fs.rmSync(`${file}.tmp`, { force: true });
console.log(`Cleared ${file}`);

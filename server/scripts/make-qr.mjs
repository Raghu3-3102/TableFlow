// Writes one QR code PNG per table of the demo restaurant into ../qr-codes/.
// Usage: node scripts/make-qr.mjs [baseUrl]
// Default base is http://localhost:5173. For phones on the same Wi-Fi, pass your PC's address,
// e.g. node scripts/make-qr.mjs http://192.168.1.20:5173
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mongoose from 'mongoose';
import QRCode from 'qrcode';
import { config } from '../src/config.js';
import { Restaurant, Table } from '../src/models.js';

const base = (process.argv[2] || 'http://localhost:5173').replace(/\/$/, '');
const outDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'qr-codes');

await mongoose.connect(config.mongoUri);
const restaurant = await Restaurant.findOne({ name: 'Spice Garden (Demo)' }).lean();
if (!restaurant) {
  console.error('Demo restaurant not found. Run npm run seed first.');
  process.exit(1);
}
const tables = await Table.find({ restaurant: restaurant._id }).sort({ number: 1 }).lean();

fs.mkdirSync(outDir, { recursive: true });
for (const t of tables) {
  const url = `${base}/t/${t.qrToken}`;
  const file = path.join(outDir, `table-${t.number}.png`);
  await QRCode.toFile(file, url, { width: 600, margin: 2 });
  console.log(`Table ${t.number}: ${url}\n  -> ${file}`);
}
await mongoose.disconnect();

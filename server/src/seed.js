// Creates demo data: a platform admin, one demo restaurant with all staff roles, tables, menu and challenges.
// Run with: npm run seed   (safe to re-run; it resets only the demo restaurant)
import bcrypt from 'bcryptjs';
import mongoose from 'mongoose';
import { config } from './config.js';
import { Bill, Call, Challenge, ChallengeAward, MenuItem, Order, Restaurant, Table, User } from './models.js';
import crypto from 'node:crypto';

await mongoose.connect(config.mongoUri);

const hash = (p) => bcrypt.hash(p, 10);

await User.deleteMany({ email: { $in: ['admin@tableflow.test', 'owner@spicegarden.test', 'manager@spicegarden.test', 'staff@spicegarden.test', 'cook@spicegarden.test'] } });
await User.deleteMany({ role: 'admin' });
await User.create({ name: 'Platform Admin', email: 'admin@tableflow.test', passwordHash: await hash('admin123'), role: 'admin' });

let restaurant = await Restaurant.findOne({ name: 'Spice Garden (Demo)' });
if (restaurant) {
  const oldTables = await Table.find({ restaurant: restaurant._id }).select('_id').lean();
  await Order.deleteMany({ restaurant: restaurant._id });
  await Bill.deleteMany({ restaurant: restaurant._id });
  await Call.deleteMany({ restaurant: restaurant._id });
  await ChallengeAward.deleteMany({ restaurant: restaurant._id });
  await Challenge.deleteMany({ restaurant: restaurant._id });
  await MenuItem.deleteMany({ restaurant: restaurant._id });
  await Table.deleteMany({ _id: { $in: oldTables.map((t) => t._id) } });
  await User.deleteMany({ restaurant: restaurant._id });
  await Restaurant.deleteOne({ _id: restaurant._id });
}

restaurant = await Restaurant.create({
  name: 'Spice Garden (Demo)',
  phone: '+91 98000 00000',
  gstin: '27AAAAA0000A1Z5',
  address: 'MG Road, Demo City',
  taxPct: 5,
  serviceChargePct: 0,
  approvalMode: 'manual',
  autoApproveSeconds: 60,
  leaderboardMetric: 'points',
  invoicePrefix: 'SG',
});
const rid = restaurant._id;

await User.create([
  { name: 'Rakesh Owner', email: 'owner@spicegarden.test', passwordHash: await hash('owner123'), role: 'owner', restaurant: rid },
  { name: 'Meena Manager', email: 'manager@spicegarden.test', passwordHash: await hash('manager123'), role: 'manager', restaurant: rid },
  { name: 'Arjun Staff', email: 'staff@spicegarden.test', passwordHash: await hash('staff123'), role: 'staff', restaurant: rid },
  { name: 'Ravi Cook', email: 'cook@spicegarden.test', passwordHash: await hash('cook123'), role: 'cook', restaurant: rid },
]);

const tables = [];
for (const n of ['1', '2', '3', '4', '5', '6']) {
  tables.push(await Table.create({ restaurant: rid, number: n, qrToken: crypto.randomBytes(9).toString('base64url') }));
}

const spice = (label, options, required = false) => ({ label, options, required });
await MenuItem.create([
  { restaurant: rid, name: 'Paneer Tikka', category: 'Starters', price: 260, veg: true, prepMinutes: 12, allergens: ['milk'], bestseller: true, checklist: [spice('Spice level', ['Mild', 'Medium', 'Hot'], true)] },
  { restaurant: rid, name: 'Chicken Tikka', category: 'Starters', price: 320, veg: false, prepMinutes: 14, checklist: [spice('Spice level', ['Mild', 'Medium', 'Hot'], true)] },
  { restaurant: rid, name: 'Veg Samosa (2 pc)', category: 'Starters', price: 90, veg: true, prepMinutes: 6 },
  { restaurant: rid, name: 'Dal Makhani', category: 'Mains', price: 240, veg: true, prepMinutes: 15, checklist: [spice('Spice level', ['Mild', 'Medium', 'Hot']), spice('Butter', ['Less', 'Regular', 'Extra'])] },
  { restaurant: rid, name: 'Butter Chicken', category: 'Mains', price: 360, veg: false, prepMinutes: 18, featured: true, allergens: ['milk'], checklist: [spice('Spice level', ['Mild', 'Medium', 'Hot'], true)] },
  { restaurant: rid, name: 'Garlic Naan', category: 'Breads', price: 60, veg: true, prepMinutes: 8, allergens: ['gluten', 'milk'] },
  { restaurant: rid, name: 'Jeera Rice', category: 'Rice', price: 150, veg: true, prepMinutes: 10, vegan: true },
  { restaurant: rid, name: 'Gulab Jamun', category: 'Desserts', price: 110, veg: true, prepMinutes: 4 },
  { restaurant: rid, name: 'Mango Lassi', category: 'Drinks', price: 120, veg: true, prepMinutes: 3, sizes: [{ label: 'Regular', price: 120 }, { label: 'Large', price: 160 }], allergens: ['milk'], bestseller: true },
  { restaurant: rid, name: 'Masala Chai', category: 'Drinks', price: 50, veg: true, prepMinutes: 4, happyHourPct: 20, happyHourFrom: 15, happyHourTo: 18, allergens: ['milk'] },
]);

await Challenge.create([
  { restaurant: rid, title: 'Try 3 different dishes', kind: 'distinct_dishes', target: 3, points: 10 },
  { restaurant: rid, title: 'Order a dessert', kind: 'category', category: 'Desserts', target: 1, points: 15 },
  { restaurant: rid, title: 'Order 2 rounds', kind: 'orders_count', target: 2, points: 20 },
]);

console.log('Demo data ready.');
console.log('Platform admin : admin@tableflow.test / admin123');
console.log('Owner          : owner@spicegarden.test / owner123');
console.log('Manager        : manager@spicegarden.test / manager123');
console.log('Staff          : staff@spicegarden.test / staff123');
console.log('Cook           : cook@spicegarden.test / cook123');
console.log('Table QR codes:');
for (const t of tables) console.log(`  Table ${t.number}: http://localhost:5173/t/${t.qrToken}`);
await mongoose.disconnect();

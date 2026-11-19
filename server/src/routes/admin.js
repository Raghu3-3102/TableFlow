import bcrypt from 'bcryptjs';
import { Router } from 'express';
import { requireAuth, requireRole } from '../auth.js';
import { Bill, Restaurant, User } from '../models.js';

const router = Router();
router.use(requireAuth, requireRole('admin'));

const money = (n) => Math.round(n * 100) / 100;

function startOfDay(d = new Date()) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

// Platform overview: every restaurant with its payment status.
router.get('/restaurants', async (req, res) => {
  const period = req.query.period === 'month' ? 'month' : 'today';
  const from =
    period === 'month' ? new Date(new Date().getFullYear(), new Date().getMonth(), 1) : startOfDay();
  const restaurants = await Restaurant.find().sort({ name: 1 }).lean();
  const owners = await User.find({ role: 'owner' }).lean();
  const bills = await Bill.find({ createdAt: { $gte: from } }).lean();
  const openBills = await Bill.find({ status: 'open' }).lean();

  const rows = restaurants.map((r) => {
    const rb = bills.filter((b) => String(b.restaurant) === String(r._id));
    const paidBills = rb.filter((b) => b.status === 'paid');
    const collected = rb.reduce((sum, b) => sum + b.paid, 0);
    const byMethod = { cash: 0, upi: 0, card: 0 };
    for (const b of rb) for (const p of b.payments) byMethod[p.method] = (byMethod[p.method] || 0) + p.amount;
    const open = openBills.filter((b) => String(b.restaurant) === String(r._id));
    const outstanding = open.reduce((sum, b) => sum + Math.max(0, b.total - b.paid), 0);
    const owner = owners.find((o) => String(o.restaurant) === String(r._id));
    return {
      id: String(r._id),
      name: r.name,
      owner: owner ? { name: owner.name, email: owner.email } : null,
      subscriptionStatus: r.subscriptionStatus,
      billsCount: rb.length,
      billsPaid: paidBills.length,
      collected: money(collected),
      byMethod: Object.fromEntries(Object.entries(byMethod).map(([k, v]) => [k, money(v)])),
      openBills: open.length,
      outstanding: money(outstanding),
      paymentStatus: outstanding > 0 ? 'pending' : 'clear',
    };
  });

  const totals = rows.reduce(
    (acc, r) => {
      acc.collected += r.collected;
      acc.outstanding += r.outstanding;
      acc.bills += r.billsCount;
      acc.cash += r.byMethod.cash;
      acc.upi += r.byMethod.upi;
      acc.card += r.byMethod.card;
      return acc;
    },
    { collected: 0, outstanding: 0, bills: 0, cash: 0, upi: 0, card: 0 }
  );
  res.json({ period, totals: Object.fromEntries(Object.entries(totals).map(([k, v]) => [k, money(v)])), restaurants: rows });
});

// Creates a restaurant together with its owner login.
router.post('/restaurants', async (req, res) => {
  const { name, phone, gstin, address, taxPct, serviceChargePct, owner } = req.body || {};
  if (!name || !owner?.name || !owner?.email || !owner?.password) {
    return res.status(400).json({ error: 'Restaurant name and owner name, email and password are needed.' });
  }
  if (owner.password.length < 6) return res.status(400).json({ error: 'Owner password must be at least 6 characters.' });
  if (await User.exists({ email: owner.email.toLowerCase() })) {
    return res.status(409).json({ error: 'That owner email is already in use.' });
  }
  const restaurant = await Restaurant.create({
    name,
    phone,
    gstin,
    address,
    taxPct: taxPct ?? 5,
    serviceChargePct: serviceChargePct ?? 0,
  });
  const user = await User.create({
    name: owner.name,
    email: owner.email,
    passwordHash: await bcrypt.hash(owner.password, 10),
    role: 'owner',
    restaurant: restaurant._id,
  });
  res.status(201).json({ restaurant, owner: { id: String(user._id), email: user.email } });
});

// Suspend or reactivate a restaurant, for example after a missed payment.
router.patch('/restaurants/:id', async (req, res) => {
  const { subscriptionStatus } = req.body || {};
  if (!['active', 'suspended'].includes(subscriptionStatus)) {
    return res.status(400).json({ error: 'Status must be active or suspended.' });
  }
  const r = await Restaurant.findByIdAndUpdate(req.params.id, { subscriptionStatus }, { new: true }).lean();
  if (!r) return res.status(404).json({ error: 'Restaurant not found.' });
  res.json({ restaurant: r });
});

// Quick check for the platform owner: list recent payments across all restaurants.
router.get('/payments', async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const bills = await Bill.find({ 'payments.0': { $exists: true } })
    .sort({ updatedAt: -1 })
    .limit(limit)
    .lean();
  const names = Object.fromEntries(
    (await Restaurant.find({}, 'name').lean()).map((r) => [String(r._id), r.name])
  );
  const rows = [];
  for (const b of bills) {
    for (const p of b.payments) {
      rows.push({
        restaurant: names[String(b.restaurant)] || 'Unknown',
        invoiceNo: b.invoiceNo,
        table: b.tableNumber,
        amount: p.amount,
        method: p.method,
        shareLabel: p.shareLabel,
        paidAt: p.paidAt,
        billStatus: b.status,
      });
    }
  }
  rows.sort((a, b) => new Date(b.paidAt) - new Date(a.paidAt));
  res.json({ payments: rows.slice(0, limit) });
});

export default router;

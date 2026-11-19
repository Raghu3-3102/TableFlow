import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { Router } from 'express';
import { requireAuth, requireRole } from '../auth.js';
import { billableItems, computeBill, computeTotals, nextInvoiceNo } from '../billing.js';
import { audit } from '../audit.js';
import { evaluateChallenges, broadcastLeaderboard, leaderboard } from '../game.js';
import { notifyRestaurant, notifyTable } from '../realtime.js';
import { cleanMenuFields } from '../menu.js';
import reportRoutes from './reports.js';
import { AuditLog, Bill, Call, Challenge, Feedback, MenuItem, Order, Restaurant, Table, User } from '../models.js';

const router = Router();
router.use(requireAuth, requireRole('owner', 'manager', 'staff', 'cook'));
// Owner and manager reports. Each report route checks its own role.
router.use('/reports', reportRoutes);

const STAFF = ['owner', 'manager', 'staff', 'cook'];
const MANAGE = ['owner', 'manager'];
const FLOOR = ['owner', 'manager', 'staff'];
const KITCHEN = ['owner', 'manager', 'staff', 'cook'];
const money = (n) => Math.round(n * 100) / 100;
const startOfDay = () => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
};
const httpError = (status, message) => Object.assign(new Error(message), { status });

// Every request in this router only sees its own restaurant.
const rid = (req) => req.user.restaurant;

function ownsTable(req, table) {
  return table && String(table.restaurant) === rid(req);
}

// Approves an order (optionally editing quantities; qty 0 removes an item). Shared with auto-approve.
export async function approveOrder(order, { edits = [], approverId = null } = {}) {
  if (order.status !== 'pending') throw httpError(409, 'Only pending orders can be approved.');
  for (const edit of edits) {
    const item = order.items.id(edit.id);
    if (!item) continue;
    const qty = Math.floor(Number(edit.qty));
    if (qty === 0) item.status = 'cancelled';
    else if (qty > 0) item.qty = qty;
  }
  for (const item of order.items) {
    if (item.status === 'pending') item.status = 'approved';
  }
  if (order.items.every((i) => i.status === 'cancelled')) {
    order.status = 'rejected';
    order.rejectReason = 'All items were removed';
  } else {
    order.status = 'approved';
    order.approvedAt = new Date();
    order.approvedBy = approverId;
  }
  await order.save();
  notifyRestaurant(order.restaurant, 'orders:changed', { orderId: String(order._id) });
  notifyTable(order.restaurant, order.table, 'status:changed', { orderId: String(order._id) });
  if (order.status === 'approved') {
    evaluateChallenges(order.restaurant, order.table).catch((e) => console.error('game eval', e));
  }
  return order;
}

// ---------- Overview (owner and manager) ----------
router.get('/overview', requireRole(...MANAGE), async (req, res) => {
  const restaurantId = rid(req);
  const from = startOfDay();
  const bills = await Bill.find({ restaurant: restaurantId, status: 'paid', closedAt: { $gte: from } }).lean();
  const orders = await Order.find({ restaurant: restaurantId, createdAt: { $gte: from }, status: { $ne: 'rejected' } }).lean();
  const tables = await Table.find({ restaurant: restaurantId }).lean();
  const pending = await Order.countDocuments({ restaurant: restaurantId, status: 'pending' });
  const openCalls = await Call.countDocuments({ restaurant: restaurantId, status: 'open' });
  const openBills = await Bill.find({ restaurant: restaurantId, status: 'open' }).lean();

  const now = Date.now();
  const late = [];
  const topMap = {};
  for (const o of orders) {
    for (const i of o.items) {
      if (i.status === 'rejected' || i.status === 'cancelled') continue;
      topMap[i.name] = (topMap[i.name] || 0) + i.qty;
      if (i.status === 'preparing' && i.startedAt && now > new Date(i.startedAt).getTime() + i.prepMinutes * 60000) {
        late.push({ table: o.tableNumber, item: i.name });
      }
    }
  }
  const sales = bills.reduce((s, b) => s + b.total, 0);
  const top = Object.entries(topMap)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([name, qty]) => ({ name, qty }));

  res.json({
    today: {
      sales: money(sales),
      bills: bills.length,
      avgOrderValue: bills.length ? money(sales / bills.length) : 0,
      orders: orders.length,
    },
    live: {
      occupiedTables: tables.filter((t) => t.status === 'occupied').length,
      billingTables: tables.filter((t) => t.status === 'billing').length,
      totalTables: tables.length,
      pendingApprovals: pending,
      openCalls,
      outstanding: money(openBills.reduce((s, b) => s + Math.max(0, b.total - b.paid), 0)),
    },
    lateItems: late.slice(0, 10),
    topItems: top,
  });
});

// ---------- Menu ----------
router.get('/menu', async (req, res) => {
  const items = await MenuItem.find({ restaurant: rid(req) }).sort({ category: 1, name: 1 }).lean();
  res.json({ items });
});

function cleanChecklist(list = []) {
  return list
    .filter((c) => c && c.label)
    .map((c) => ({
      label: String(c.label).trim(),
      options: (c.options || []).map((o) => String(o).trim()).filter(Boolean),
      required: Boolean(c.required),
    }));
}

router.post('/menu', requireRole(...MANAGE), async (req, res) => {
  const { name, category, description, price, veg, prepMinutes, checklist } = req.body || {};
  if (!name || price === undefined || Number(price) < 0) return res.status(400).json({ error: 'Name and a valid price are needed.' });
  try {
    const item = await MenuItem.create({
      restaurant: rid(req),
      name,
      category: category || 'General',
      description,
      price: Number(price),
      veg: veg !== false,
      prepMinutes: Number(prepMinutes) || 10,
      checklist: cleanChecklist(checklist),
      ...cleanMenuFields(req.body || {}),
    });
    res.status(201).json({ item });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.patch('/menu/:id', requireRole(...MANAGE), async (req, res) => {
  const body = { ...req.body };
  if (body.checklist) body.checklist = cleanChecklist(body.checklist);
  delete body.restaurant;
  try {
    const update = { ...body, ...cleanMenuFields(req.body || {}) };
    const item = await MenuItem.findOneAndUpdate({ _id: req.params.id, restaurant: rid(req) }, update, { new: true }).lean();
    if (!item) return res.status(404).json({ error: 'Menu item not found.' });
    notifyRestaurant(rid(req), 'menu:changed', {});
    res.json({ item });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// 86 control: any floor or kitchen role can take an item off every guest menu at once.
router.patch('/menu/:id/availability', async (req, res) => {
  const item = await MenuItem.findOneAndUpdate(
    { _id: req.params.id, restaurant: rid(req) },
    { available: Boolean(req.body?.available) },
    { new: true }
  ).lean();
  if (!item) return res.status(404).json({ error: 'Menu item not found.' });
  notifyRestaurant(rid(req), 'menu:changed', {});
  res.json({ item });
});

router.delete('/menu/:id', requireRole('owner'), async (req, res) => {
  await MenuItem.deleteOne({ _id: req.params.id, restaurant: rid(req) });
  res.json({ ok: true });
});

// ---------- Tables ----------
router.get('/tables', async (req, res) => {
  const tables = await Table.find({ restaurant: rid(req) }).sort({ number: 1 }).lean();
  const open = await Order.find({
    restaurant: rid(req),
    status: 'approved',
    table: { $in: tables.map((t) => t._id) },
  }).lean();
  const rows = tables.map((t) => {
    const mine = open.filter((o) => String(o.table) === String(t._id));
    const subtotal = billableItems(mine).reduce((s, i) => s + i.price * i.qty, 0);
    return { ...t, openOrders: mine.length, subtotal: money(subtotal) };
  });
  res.json({ tables: rows });
});

router.post('/tables', requireRole(...MANAGE), async (req, res) => {
  const number = String(req.body?.number || '').trim();
  if (!number) return res.status(400).json({ error: 'Table number is needed.' });
  try {
    const table = await Table.create({
      restaurant: rid(req),
      number,
      qrToken: crypto.randomBytes(9).toString('base64url'),
    });
    res.status(201).json({ table });
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ error: `Table ${number} already exists.` });
    throw err;
  }
});

router.delete('/tables/:id', requireRole('owner'), async (req, res) => {
  const table = await Table.findById(req.params.id).lean();
  if (!ownsTable(req, table)) return res.status(404).json({ error: 'Table not found.' });
  if (table.status !== 'free') return res.status(409).json({ error: 'Close the table bill before removing this table.' });
  await Table.deleteOne({ _id: table._id });
  res.json({ ok: true });
});

// Staff free a table manually, for example after a walk-out with no bill.
router.post('/tables/:id/free', async (req, res) => {
  const table = await Table.findById(req.params.id);
  if (!ownsTable(req, table)) return res.status(404).json({ error: 'Table not found.' });
  const hasOpenBill = await Bill.exists({ table: table._id, status: 'open' });
  if (hasOpenBill) return res.status(409).json({ error: 'This table still has an open bill.' });
  const openOrders = await Order.countDocuments({ table: table._id, status: { $in: ['pending', 'approved'] } });
  if (openOrders) return res.status(409).json({ error: 'This table still has active orders.' });
  table.status = 'free';
  table.sessionStartedAt = null;
  await table.save();
  await audit(rid(req), req.user, 'table_freed', `Table ${table.number} marked free without a bill`);
  notifyRestaurant(rid(req), 'tables:changed', {});
  res.json({ table });
});

// ---------- Staff accounts ----------
router.get('/staff', requireRole(...MANAGE), async (req, res) => {
  const staff = await User.find({ restaurant: rid(req), role: { $in: ['manager', 'staff', 'cook'] } })
    .select('name email role active')
    .sort({ role: 1, name: 1 })
    .lean();
  res.json({ staff });
});

router.post('/staff', requireRole(...MANAGE), async (req, res) => {
  const { name, email, password, role } = req.body || {};
  const allowed = req.user.role === 'owner' ? ['manager', 'staff', 'cook'] : ['staff', 'cook'];
  if (!allowed.includes(role)) return res.status(403).json({ error: 'You cannot create that role.' });
  if (!name || !email || !password || password.length < 6) {
    return res.status(400).json({ error: 'Name, email and a 6+ character password are needed.' });
  }
  if (await User.exists({ email: String(email).toLowerCase() })) {
    return res.status(409).json({ error: 'That email is already in use.' });
  }
  const user = await User.create({
    name,
    email,
    role,
    restaurant: rid(req),
    passwordHash: await bcrypt.hash(password, 10),
  });
  await audit(rid(req), req.user, 'staff_added', `${name} (${role})`);
  res.status(201).json({ user: { id: String(user._id), name, email, role, active: true } });
});

router.patch('/staff/:id', requireRole('owner'), async (req, res) => {
  const update = {};
  if (typeof req.body?.active === 'boolean') update.active = req.body.active;
  const user = await User.findOneAndUpdate(
    { _id: req.params.id, restaurant: rid(req), role: { $in: ['manager', 'staff', 'cook'] } },
    update,
    { new: true }
  )
    .select('name email role active')
    .lean();
  if (!user) return res.status(404).json({ error: 'Staff member not found.' });
  res.json({ user });
});

// ---------- Settings ----------
router.get('/settings', requireRole(...MANAGE), async (req, res) => {
  const r = await Restaurant.findById(rid(req)).lean();
  res.json({ restaurant: r });
});

router.patch('/settings', requireRole('owner'), async (req, res) => {
  const allowed = [
    'name', 'phone', 'gstin', 'address', 'taxPct', 'serviceChargePct',
    'approvalMode', 'autoApproveSeconds', 'leaderboardMetric', 'invoicePrefix', 'managerDiscountCapPct',
  ];
  const update = {};
  for (const k of allowed) if (req.body?.[k] !== undefined) update[k] = req.body[k];
  const r = await Restaurant.findByIdAndUpdate(rid(req), update, { new: true }).lean();
  await audit(rid(req), req.user, 'settings_changed', Object.keys(update).join(', '));
  notifyRestaurant(rid(req), 'settings:changed', {});
  res.json({ restaurant: r });
});

// ---------- Challenges and game ----------
router.get('/challenges', async (req, res) => {
  const challenges = await Challenge.find({ restaurant: rid(req) }).sort({ createdAt: 1 }).lean();
  res.json({ challenges });
});

function cleanChallenge(body) {
  const kind = body.kind;
  if (!['distinct_dishes', 'category', 'orders_count'].includes(kind)) throw httpError(400, 'Pick a valid challenge type.');
  if (kind === 'category' && !body.category) throw httpError(400, 'Category challenges need a category name.');
  return {
    title: String(body.title || '').trim(),
    kind,
    target: Math.max(1, Math.floor(Number(body.target) || 1)),
    category: kind === 'category' ? String(body.category).trim() : undefined,
    points: Math.max(1, Math.floor(Number(body.points) || 10)),
    active: body.active !== false,
  };
}

router.post('/challenges', requireRole(...MANAGE), async (req, res) => {
  try {
    const data = cleanChallenge(req.body || {});
    if (!data.title) return res.status(400).json({ error: 'Give the challenge a title.' });
    const challenge = await Challenge.create({ ...data, restaurant: rid(req) });
    res.status(201).json({ challenge });
    broadcastLeaderboard(rid(req));
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
});

router.patch('/challenges/:id', requireRole(...MANAGE), async (req, res) => {
  try {
    const data = cleanChallenge({ ...req.body });
    const challenge = await Challenge.findOneAndUpdate({ _id: req.params.id, restaurant: rid(req) }, data, { new: true }).lean();
    if (!challenge) return res.status(404).json({ error: 'Challenge not found.' });
    res.json({ challenge });
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
});

router.delete('/challenges/:id', requireRole(...MANAGE), async (req, res) => {
  await Challenge.deleteOne({ _id: req.params.id, restaurant: rid(req) });
  res.json({ ok: true });
});

// Starts a new game period. Points and rankings before this moment stop counting.
router.post('/game/reset', requireRole(...MANAGE), async (req, res) => {
  await Restaurant.findByIdAndUpdate(rid(req), { gamePeriodStart: new Date() });
  await broadcastLeaderboard(rid(req));
  res.json({ ok: true });
});

router.get('/leaderboard', async (req, res) => {
  res.json(await leaderboard(rid(req)));
});

// ---------- Orders: approval queue and kitchen ----------
router.get('/orders', async (req, res) => {
  const status = req.query.status || 'pending';
  const filter = { restaurant: rid(req) };
  if (status === 'kitchen') {
    filter.status = 'approved';
    filter['items.status'] = { $in: ['approved', 'preparing', 'ready'] };
  } else if (status !== 'all') {
    filter.status = status;
  }
  const orders = await Order.find(filter).sort({ createdAt: 1 }).limit(200).lean();
  res.json({ orders });
});

// Approve: staff can edit quantities or remove items before the kitchen sees them.
router.patch('/orders/:id/approve', requireRole(...FLOOR), async (req, res) => {
  const order = await Order.findById(req.params.id);
  if (!order || String(order.restaurant) !== rid(req)) return res.status(404).json({ error: 'Order not found.' });
  try {
    await approveOrder(order, { edits: req.body?.items || [], approverId: req.user.id });
    res.json({ order });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.patch('/orders/:id/reject', requireRole(...FLOOR), async (req, res) => {
  const order = await Order.findById(req.params.id);
  if (!order || String(order.restaurant) !== rid(req)) return res.status(404).json({ error: 'Order not found.' });
  if (order.status !== 'pending') return res.status(409).json({ error: 'Only pending orders can be rejected.' });
  order.status = 'rejected';
  order.rejectReason = String(req.body?.reason || 'Rejected by staff').slice(0, 140);
  order.items.forEach((i) => (i.status = 'rejected'));
  await order.save();
  await audit(rid(req), req.user, 'reject_order', `Table ${order.tableNumber} · ${order.rejectReason}`);
  notifyRestaurant(rid(req), 'orders:changed', { orderId: String(order._id) });
  notifyTable(rid(req), order.table, 'status:changed', { orderId: String(order._id) });
  res.json({ order });
});

const ITEM_FLOW = {
  approved: ['preparing'],
  preparing: ['ready'],
  ready: ['served'],
};

// Moves one item through the kitchen. "ready" needs every checklist choice ticked by the cook.
router.patch('/orders/:id/items/:itemId', requireRole(...KITCHEN), async (req, res) => {
  const { status, checklistTicks } = req.body || {};
  const order = await Order.findById(req.params.id);
  if (!order || String(order.restaurant) !== rid(req)) return res.status(404).json({ error: 'Order not found.' });
  const item = order.items.id(req.params.itemId);
  if (!item) return res.status(404).json({ error: 'Item not found.' });

  const allowedNext = ITEM_FLOW[item.status] || [];
  if (!allowedNext.includes(status)) {
    return res.status(409).json({ error: `An item that is ${item.status} cannot move to ${status}.` });
  }
  if (status === 'served' && !['owner', 'manager', 'staff'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Only floor staff can mark items served.' });
  }
  if (status === 'ready') {
    const choices = item.selections.map((s) => s.label);
    const ticks = Array.isArray(checklistTicks) ? checklistTicks : [];
    const missing = choices.filter((label) => !ticks.includes(label));
    if (missing.length) {
      return res.status(409).json({ error: `Tick the checklist first: ${missing.join(', ')}.` });
    }
    item.checklistTicks = ticks;
    item.readyAt = new Date();
  }
  if (status === 'preparing') item.startedAt = new Date();
  item.status = status;
  await order.save();
  notifyRestaurant(rid(req), 'orders:changed', { orderId: String(order._id) });
  notifyTable(rid(req), order.table, 'status:changed', { orderId: String(order._id), itemId: String(item._id) });
  res.json({ order });
});

// ---------- Calls ----------
router.get('/calls', requireRole(...FLOOR), async (req, res) => {
  const calls = await Call.find({ restaurant: rid(req), status: 'open' }).sort({ createdAt: 1 }).lean();
  res.json({ calls });
});

router.patch('/calls/:id/ack', requireRole(...FLOOR), async (req, res) => {
  const call = await Call.findOneAndUpdate(
    { _id: req.params.id, restaurant: rid(req) },
    { status: 'acknowledged', acknowledgedBy: req.user.id, acknowledgedAt: new Date() },
    { new: true }
  ).lean();
  if (!call) return res.status(404).json({ error: 'Call not found.' });
  notifyRestaurant(rid(req), 'calls:changed', {});
  res.json({ call });
});

// ---------- Bills and payments ----------
router.get('/bills', requireRole(...FLOOR), async (req, res) => {
  const status = req.query.status === 'paid' ? 'paid' : 'open';
  const filter = { restaurant: rid(req), status };
  if (status === 'paid') filter.closedAt = { $gte: startOfDay() };
  const bills = await Bill.find(filter).sort({ createdAt: -1 }).limit(100).lean();
  res.json({ bills });
});

// Builds the bill from every approved order in the current visit and stops new orders on the table.
router.post('/tables/:id/bill', requireRole(...FLOOR), async (req, res) => {
  const table = await Table.findById(req.params.id);
  if (!ownsTable(req, table)) return res.status(404).json({ error: 'Table not found.' });
  const existing = await Bill.findOne({ table: table._id, status: 'open' });
  if (existing) return res.json({ bill: existing });
  if (!table.sessionStartedAt) return res.status(409).json({ error: 'This table has no orders yet.' });

  const pending = await Order.countDocuments({ table: table._id, status: 'pending' });
  if (pending) return res.status(409).json({ error: 'Approve or reject the pending orders first.' });

  const orders = await Order.find({ table: table._id, status: 'approved' }).lean();
  if (!orders.length) return res.status(409).json({ error: 'No approved orders to bill.' });
  const restaurant = await Restaurant.findById(rid(req)).lean();
  const totals = computeTotals(billableItems(orders), restaurant);
  const bill = await Bill.create({
    restaurant: rid(req),
    table: table._id,
    tableNumber: table.number,
    orders: orders.map((o) => o._id),
    invoiceNo: await nextInvoiceNo(rid(req)),
    ...totals,
  });
  table.status = 'billing';
  await table.save();
  notifyRestaurant(rid(req), 'bills:changed', {});
  notifyTable(rid(req), table._id, 'status:changed', { billId: String(bill._id) });
  res.status(201).json({ bill });
});

// Discount by rupee amount or percentage. A reason is required. Managers are capped at the owner's limit.
// Tax is recalculated on the discounted value, as GST requires for discounts shown on the invoice.
router.post('/bills/:id/discount', requireRole(...MANAGE), async (req, res) => {
  const bill = await Bill.findById(req.params.id);
  if (!bill || String(bill.restaurant) !== rid(req)) return res.status(404).json({ error: 'Bill not found.' });
  if (bill.status !== 'open') return res.status(409).json({ error: 'This bill is already settled.' });
  if (bill.paid > 0) return res.status(409).json({ error: 'Discounts can only be added before any payment is taken.' });

  const type = req.body?.type === 'percent' ? 'percent' : 'amount';
  const value = Number(req.body?.value ?? 0);
  const reason = String(req.body?.reason || '').trim();
  if (!Number.isFinite(value) || value < 0) return res.status(400).json({ error: 'Enter a discount of zero or more.' });
  if (type === 'percent' && value > 100) return res.status(400).json({ error: 'A percentage discount cannot be more than 100.' });
  if (value > 0 && reason.length < 3) return res.status(400).json({ error: 'Give a short reason, for example "regular customer".' });

  const restaurant = await Restaurant.findById(rid(req)).lean();
  const amount = type === 'percent' ? (bill.subtotal * value) / 100 : value;
  const pct = bill.subtotal ? (amount / bill.subtotal) * 100 : 0;
  const cap = restaurant.managerDiscountCapPct ?? 10; // older restaurants may not have the field yet
  if (req.user.role === 'manager' && pct > cap + 0.01) {
    return res.status(403).json({ error: `Managers can discount up to ${cap}%. Ask the owner for more.` });
  }
  if (amount > bill.subtotal) return res.status(400).json({ error: 'Discount cannot be more than the subtotal.' });

  const totals = computeBill(bill.subtotal, restaurant, amount);
  Object.assign(bill, totals, {
    discountType: value > 0 ? type : null,
    discountValue: value,
    discountReason: value > 0 ? reason : undefined,
    discountBy: value > 0 ? req.user.id : undefined,
    discountByName: value > 0 ? req.user.name : undefined,
  });
  await bill.save();
  await audit(
    rid(req),
    req.user,
    value > 0 ? 'discount' : 'discount_removed',
    value > 0 ? `Table ${bill.tableNumber} · ${type === 'percent' ? `${value}%` : `₹${value}`} (${totals.discount} off) · ${reason} · ${bill.invoiceNo}` : `Table ${bill.tableNumber} · ${bill.invoiceNo}`
  );
  notifyRestaurant(rid(req), 'bills:changed', {});
  res.json({ bill });
});

// ---------- Audit trail, trends and ratings (owner and manager) ----------
router.get('/audit', requireRole(...MANAGE), async (req, res) => {
  const filter = { restaurant: rid(req) };
  if (req.query.action) filter.action = String(req.query.action);
  const logs = await AuditLog.find(filter).sort({ at: -1 }).limit(200).lean();
  res.json({ logs });
});

// Paid sales per day for the last N days, for the trend chart.
router.get('/sales/daily', requireRole(...MANAGE), async (req, res) => {
  const days = Math.min(Math.max(Number(req.query.days) || 7, 1), 31);
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - (days - 1));
  const bills = await Bill.find({ restaurant: rid(req), status: 'paid', closedAt: { $gte: start } }).lean();
  const series = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    const next = new Date(d);
    next.setDate(d.getDate() + 1);
    const inDay = bills.filter((b) => b.closedAt >= d && b.closedAt < next);
    series.push({
      date: d.toISOString(),
      label: d.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric' }),
      sales: money(inDay.reduce((s, b) => s + b.total, 0)),
      bills: inDay.length,
    });
  }
  res.json({ series });
});

router.get('/feedback', requireRole(...MANAGE), async (req, res) => {
  const items = await Feedback.find({ restaurant: rid(req) }).sort({ createdAt: -1 }).limit(30).lean();
  const avg = items.length ? money(items.reduce((s, f) => s + f.rating, 0) / items.length) : null;
  res.json({ average: avg, count: items.length, items });
});

router.post('/bills/:id/payments', requireRole(...FLOOR), async (req, res) => {
  const { amount, method = 'cash', shareLabel, reference } = req.body || {};
  const bill = await Bill.findById(req.params.id);
  if (!bill || String(bill.restaurant) !== rid(req)) return res.status(404).json({ error: 'Bill not found.' });
  if (bill.status !== 'open') return res.status(409).json({ error: 'This bill is already settled.' });
  if (!['cash', 'upi', 'card'].includes(method)) return res.status(400).json({ error: 'Pick cash, UPI or card.' });
  const value = money(Number(amount));
  const due = money(bill.total - bill.paid);
  if (!(value > 0)) return res.status(400).json({ error: 'Enter an amount greater than zero.' });
  if (value > due + 0.005) return res.status(400).json({ error: `Only ₹${due} is still due on this bill.` });

  bill.payments.push({ amount: value, method, shareLabel, reference, recordedBy: req.user.id });
  bill.paid = money(bill.paid + value);
  await audit(rid(req), req.user, 'payment', `${bill.invoiceNo} · ₹${value} ${method.toUpperCase()}${shareLabel ? ` · ${shareLabel}` : ''}`);

  if (bill.paid >= bill.total - 0.005) {
    bill.status = 'paid';
    bill.closedAt = new Date();
    await Order.updateMany({ _id: { $in: bill.orders } }, { status: 'closed' });
    await Table.updateOne(
      { _id: bill.table },
      { status: 'free', sessionStartedAt: null }
    );
  }
  await bill.save();
  notifyRestaurant(rid(req), 'bills:changed', {});
  notifyRestaurant(rid(req), 'tables:changed', {});
  notifyTable(rid(req), bill.table, 'status:changed', { billId: String(bill._id) });
  if (bill.status === 'paid') await broadcastLeaderboard(rid(req));
  res.json({ bill });
});

export default router;

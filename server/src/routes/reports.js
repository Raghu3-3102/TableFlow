import { Router } from 'express';
import { requireRole } from '../auth.js';
import { Bill, Order } from '../models.js';

// Owner and manager reports: a summary for the screen, and CSV files for accounting.
// Dates are local calendar days and both ends are included.
const router = Router();
const MANAGE = ['owner', 'manager'];
router.use(requireRole(...MANAGE));

const DAY = 24 * 60 * 60 * 1000;
const money = (n) => Math.round(n * 100) / 100;
const rid = (req) => req.user.restaurant;

function parseDay(text) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(text || ''));
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

// Returns [from, to) as Date objects, or null if the range is missing, backwards, or longer than a year.
function rangeOf(query) {
  const from = parseDay(query.from);
  const last = parseDay(query.to);
  if (!from || !last) return null;
  const to = new Date(last.getTime() + DAY);
  if (to <= from || to - from > 366 * DAY) return null;
  return { from, to };
}

const dayKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// Paid bills closed inside the range, with their orders' lines (rejected and removed lines are left out).
async function salesIn(restaurant, { from, to }) {
  const bills = await Bill.find({ restaurant, status: 'paid', closedAt: { $gte: from, $lt: to } }).sort({ closedAt: 1 }).lean();
  const orders = await Order.find({ _id: { $in: bills.flatMap((b) => b.orders) } }).lean();
  const lines = [];
  for (const o of orders) {
    for (const i of o.items) {
      if (i.status === 'rejected' || i.status === 'cancelled') continue;
      lines.push({ name: i.name, category: i.category || 'General', qty: i.qty, revenue: i.price * i.qty });
    }
  }
  return { bills, lines };
}

// Groups order lines by dish name (which already includes the size, e.g. "Mango Lassi (Large)").
function groupItems(lines) {
  const map = new Map();
  for (const l of lines) {
    const g = map.get(l.name) || { name: l.name, category: l.category, qty: 0, revenue: 0 };
    g.qty += l.qty;
    g.revenue += l.revenue;
    map.set(l.name, g);
  }
  return [...map.values()].map((g) => ({ ...g, revenue: money(g.revenue) })).sort((a, b) => b.revenue - a.revenue);
}

router.get('/summary', async (req, res) => {
  const range = rangeOf(req.query);
  if (!range) return res.status(400).json({ error: 'Pick a valid date range of up to one year.' });
  const restaurant = rid(req);
  const { bills, lines } = await salesIn(restaurant, range);

  const sales = money(bills.reduce((s, b) => s + b.total, 0));
  const totals = {
    sales,
    bills: bills.length,
    average: bills.length ? money(sales / bills.length) : 0,
    discount: money(bills.reduce((s, b) => s + (b.discount || 0), 0)),
    serviceCharge: money(bills.reduce((s, b) => s + (b.serviceCharge || 0), 0)),
    tax: money(bills.reduce((s, b) => s + (b.tax || 0), 0)),
  };

  // Money received by method, counted on the day each payment was recorded.
  const payBills = await Bill.find({ restaurant, 'payments.paidAt': { $gte: range.from, $lt: range.to } }).lean();
  const payments = { cash: 0, upi: 0, card: 0 };
  for (const b of payBills) {
    for (const p of b.payments) {
      if (p.paidAt >= range.from && p.paidAt < range.to && payments[p.method] !== undefined) payments[p.method] += p.amount;
    }
  }
  for (const k of Object.keys(payments)) payments[k] = money(payments[k]);

  const items = groupItems(lines);
  const categories = [...items.reduce((m, i) => m.set(i.category, (m.get(i.category) || 0) + i.revenue), new Map())]
    .map(([name, revenue]) => ({ name, revenue: money(revenue) }))
    .sort((a, b) => b.revenue - a.revenue);

  const hours = Array.from({ length: 24 }, (_, h) => ({ hour: h, sales: 0, bills: 0 }));
  for (const b of bills) {
    const h = hours[new Date(b.closedAt).getHours()];
    h.sales += b.total;
    h.bills += 1;
  }
  for (const h of hours) h.sales = money(h.sales);

  const daysMap = new Map();
  for (let d = new Date(range.from); d < range.to; d = new Date(d.getTime() + DAY)) {
    daysMap.set(dayKey(d), { date: dayKey(d), sales: 0, bills: 0 });
  }
  for (const b of bills) {
    const d = daysMap.get(dayKey(new Date(b.closedAt)));
    if (d) {
      d.sales += b.total;
      d.bills += 1;
    }
  }
  const days = [...daysMap.values()].map((d) => ({ ...d, sales: money(d.sales) }));

  res.json({
    from: dayKey(range.from),
    to: dayKey(new Date(range.to.getTime() - DAY)),
    totals,
    payments,
    topItems: items.slice(0, 10),
    leastItems: [...items].sort((a, b) => a.qty - b.qty || a.revenue - b.revenue).slice(0, 5),
    categories,
    hours,
    days,
  });
});

// CSV cells: quote when needed, and neutralise leading = + - @ so spreadsheets do not run them as formulas.
function cell(value) {
  let s = value == null ? '' : String(value);
  if (/^[=+\-@]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function sendCsv(res, filename, header, rows) {
  // BOM first, so Excel reads rupee signs and names correctly.
  const body = '﻿' + [header, ...rows].map((r) => r.map(cell).join(',')).join('\r\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(body);
}

router.get('/sales.csv', async (req, res) => {
  const range = rangeOf(req.query);
  if (!range) return res.status(400).json({ error: 'Pick a valid date range of up to one year.' });
  const { bills } = await salesIn(rid(req), range);
  const rows = bills.map((b) => [
    new Date(b.closedAt).toLocaleString('en-IN'),
    b.invoiceNo,
    b.tableNumber,
    b.subtotal,
    b.discount,
    b.serviceCharge,
    b.tax,
    b.total,
    b.paid,
    b.payments.map((p) => `${p.method} ${p.amount}`).join('; '),
  ]);
  sendCsv(res, `sales-${dayKey(range.from)}-to-${dayKey(new Date(range.to.getTime() - DAY))}.csv`,
    ['Closed at', 'Invoice', 'Table', 'Subtotal', 'Discount', 'Service charge', 'GST', 'Total', 'Paid', 'Payments'],
    rows);
});

router.get('/items.csv', async (req, res) => {
  const range = rangeOf(req.query);
  if (!range) return res.status(400).json({ error: 'Pick a valid date range of up to one year.' });
  const { lines } = await salesIn(rid(req), range);
  const rows = groupItems(lines).map((i) => [i.name, i.category, i.qty, i.revenue]);
  sendCsv(res, `items-${dayKey(range.from)}-to-${dayKey(new Date(range.to.getTime() - DAY))}.csv`,
    ['Dish', 'Category', 'Quantity sold', 'Revenue (before discount and GST)'],
    rows);
});

export default router;

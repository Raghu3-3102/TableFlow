import { Router } from 'express';
import { billableItems, computeTotals } from '../billing.js';
import {
  GAME_POINTS_CAP_PER_VISIT,
  QUIZ_POINTS_PER_CORRECT,
  broadcastLeaderboard,
  buildQuiz,
  leaderboard,
  progressFor,
  visitGamePoints,
} from '../game.js';
import { notifyRestaurant, notifyTable } from '../realtime.js';
import { guestDish, priceFor, servingNow } from '../menu.js';
import { Bill, Call, Challenge, Feedback, GameRound, MenuItem, Order, Restaurant, Table } from '../models.js';

// Guest routes. No login: the table's QR token is the only key, and it maps to one table.
const router = Router();

async function tableByToken(token) {
  const table = await Table.findOne({ qrToken: String(token) });
  if (!table) return null;
  const restaurant = await Restaurant.findById(table.restaurant).lean();
  if (!restaurant || restaurant.subscriptionStatus === 'suspended') return null;
  return { table, restaurant };
}

// Table info, the live menu and the game rules.
router.get('/table/:token', async (req, res) => {
  const found = await tableByToken(req.params.token);
  if (!found) return res.status(404).json({ error: 'This table code is not valid. Ask staff for help.' });
  const { table, restaurant } = found;
  const items = await MenuItem.find({ restaurant: restaurant._id }).sort({ category: 1, name: 1 }).lean();
  const challenges = await Challenge.find({ restaurant: restaurant._id, active: true }).lean();
  const now = new Date();
  res.json({
    table: { id: String(table._id), number: table.number, status: table.status },
    restaurant: { id: String(restaurant._id), name: restaurant.name, taxPct: restaurant.taxPct, serviceChargePct: restaurant.serviceChargePct },
    menu: items.map((m) => guestDish(m, now)),
    challenges: challenges.map((c) => ({ id: String(c._id), title: c.title, kind: c.kind, target: c.target, category: c.category, points: c.points })),
  });
});

// Current visit: orders with item status, open bill and challenge progress.
router.get('/table/:token/status', async (req, res) => {
  const found = await tableByToken(req.params.token);
  if (!found) return res.status(404).json({ error: 'This table code is not valid.' });
  const { table, restaurant } = found;
  const orders = table.sessionStartedAt
    ? await Order.find({ table: table._id, createdAt: { $gte: table.sessionStartedAt } }).sort({ createdAt: 1 }).lean()
    : [];
  const bill = await Bill.findOne({ table: table._id, status: 'open' }).lean();
  const challenges = await Challenge.find({ restaurant: restaurant._id, active: true }).lean();
  // Offer a rating for a bill paid in the last 3 hours that has not been rated yet.
  let rateable = null;
  if (!bill) {
    const recent = await Bill.findOne({
      table: table._id,
      status: 'paid',
      closedAt: { $gte: new Date(Date.now() - 3 * 60 * 60 * 1000) },
    })
      .sort({ closedAt: -1 })
      .lean();
    if (recent && !(await Feedback.exists({ bill: recent._id }))) {
      rateable = { billId: String(recent._id), invoiceNo: recent.invoiceNo };
    }
  }
  const progress = challenges.map((c) => ({
    id: String(c._id),
    title: c.title,
    points: c.points,
    ...progressFor(c, orders),
  }));
  res.json({
    table: { number: table.number, status: table.status },
    orders: orders.map((o) => ({
      id: String(o._id),
      status: o.status,
      nickname: o.nickname,
      createdAt: o.createdAt,
      rejectReason: o.rejectReason,
      items: o.items.map((i) => ({
        id: String(i._id),
        name: i.name,
        qty: i.qty,
        status: i.status,
        selections: i.selections,
        startedAt: i.startedAt,
        prepMinutes: i.prepMinutes,
      })),
    })),
    bill: bill
      ? {
          invoiceNo: bill.invoiceNo,
          subtotal: bill.subtotal,
          serviceCharge: bill.serviceCharge,
          tax: bill.tax,
          discount: bill.discount,
          total: bill.total,
          paid: bill.paid,
          due: Math.max(0, bill.total - bill.paid),
        }
      : null,
    progress,
    rateable,
  });
});

// Guest rates the meal after paying. One rating per bill.
router.post('/table/:token/feedback', async (req, res) => {
  const found = await tableByToken(req.params.token);
  if (!found) return res.status(404).json({ error: 'This table code is not valid.' });
  const { table, restaurant } = found;
  const rating = Math.floor(Number(req.body?.rating));
  if (!(rating >= 1 && rating <= 5)) return res.status(400).json({ error: 'Choose between 1 and 5 stars.' });
  const bill = await Bill.findOne({ table: table._id, status: 'paid' }).sort({ closedAt: -1 }).lean();
  if (!bill) return res.status(409).json({ error: 'You can rate after your bill is paid.' });
  if (await Feedback.exists({ bill: bill._id })) return res.status(409).json({ error: 'Thanks, you have already rated this visit.' });
  await Feedback.create({
    restaurant: restaurant._id,
    table: table._id,
    tableNumber: table.number,
    bill: bill._id,
    rating,
    comment: String(req.body?.comment || '').trim().slice(0, 280),
    nickname: String(req.body?.nickname || '').slice(0, 20) || undefined,
  });
  notifyRestaurant(restaurant._id, 'feedback:changed', {});
  res.status(201).json({ ok: true });
});

// Guest places an order. It is always pending until staff approve it.
router.post('/table/:token/orders', async (req, res) => {
  const found = await tableByToken(req.params.token);
  if (!found) return res.status(404).json({ error: 'This table code is not valid.' });
  const { table, restaurant } = found;
  if (table.status === 'billing') {
    return res.status(409).json({ error: 'The bill is being settled. Ask staff to reopen the table.' });
  }
  const lines = Array.isArray(req.body?.items) ? req.body.items : [];
  if (!lines.length) return res.status(400).json({ error: 'Add at least one item to your order.' });
  if (lines.length > 40) return res.status(400).json({ error: 'That is too many items in one order.' });

  const ids = lines.map((l) => l.menuItemId);
  const menu = await MenuItem.find({ _id: { $in: ids }, restaurant: restaurant._id }).lean();
  const byId = Object.fromEntries(menu.map((m) => [String(m._id), m]));

  const items = [];
  const now = new Date();
  for (const line of lines) {
    const m = byId[String(line.menuItemId)];
    if (!m) return res.status(400).json({ error: 'One item is no longer on the menu. Please refresh.' });
    if (!m.available) return res.status(409).json({ error: `${m.name} is sold out right now.` });
    if (!servingNow(m, now)) {
      return res.status(409).json({ error: `${m.name} is served only at certain hours. Please check the menu.` });
    }
    const qty = Math.floor(Number(line.qty) || 0);
    if (qty < 1 || qty > 20) return res.status(400).json({ error: `Quantity for ${m.name} must be between 1 and 20.` });

    // Sized dishes need a size from the list. The price and the name on the kitchen ticket include it.
    let size = '';
    if (m.sizes?.length) {
      size = String(line.size || '');
      if (!m.sizes.some((s) => s.label === size)) return res.status(400).json({ error: `Choose a size for ${m.name}.` });
    }

    const selections = [];
    for (const c of m.checklist) {
      const picked = (line.selections || []).find((s) => s.label === c.label);
      if (c.required && (!picked || !c.options.includes(picked.choice))) {
        return res.status(400).json({ error: `Choose ${c.label} for ${m.name}.` });
      }
      if (picked && c.options.includes(picked.choice)) selections.push({ label: c.label, choice: picked.choice });
    }
    items.push({
      menuItem: m._id,
      name: size ? `${m.name} (${size})` : m.name,
      category: m.category,
      size: size || undefined,
      price: priceFor(m, size, now),
      qty,
      notes: String(line.notes || '').slice(0, 140),
      selections,
      prepMinutes: m.prepMinutes,
      status: 'pending',
    });
  }

  if (!table.sessionStartedAt) {
    table.sessionStartedAt = now;
  }
  table.status = 'occupied';
  await table.save();

  const order = await Order.create({
    restaurant: restaurant._id,
    table: table._id,
    tableNumber: table.number,
    nickname: String(req.body?.nickname || '').slice(0, 20) || undefined,
    items,
    status: 'pending',
  });

  notifyRestaurant(restaurant._id, 'orders:changed', { orderId: String(order._id) });
  notifyRestaurant(restaurant._id, 'tables:changed', {});
  notifyTable(restaurant._id, table._id, 'status:changed', { orderId: String(order._id) });
  res.status(201).json({ orderId: String(order._id) });
});

// One-tap call for water, cutlery, bill or help.
router.post('/table/:token/call', async (req, res) => {
  const found = await tableByToken(req.params.token);
  if (!found) return res.status(404).json({ error: 'This table code is not valid.' });
  const { table, restaurant } = found;
  const kind = ['water', 'cutlery', 'bill', 'help', 'other'].includes(req.body?.kind) ? req.body.kind : 'help';

  // Simple flood guard: one open call of the same kind per table.
  const open = await Call.findOne({ table: table._id, kind, status: 'open' });
  if (open) return res.json({ callId: String(open._id), already: true });

  const call = await Call.create({
    restaurant: restaurant._id,
    table: table._id,
    tableNumber: table.number,
    kind,
    note: String(req.body?.note || '').slice(0, 140),
  });
  notifyRestaurant(restaurant._id, 'calls:changed', {});
  res.status(201).json({ callId: String(call._id) });
});

// Public leaderboard for the guest page and the counter screen.
router.get('/table/:token/leaderboard', async (req, res) => {
  const found = await tableByToken(req.params.token);
  if (!found) return res.status(404).json({ error: 'This table code is not valid.' });
  const board = await leaderboard(found.restaurant._id);
  res.json({ metric: board.metric, rows: board.rows.map(({ tableNumber, points, orders, dishes, rank, tableId, spend }) => ({
    tableNumber, points, orders, dishes, rank, tableId, spend: board.metric === 'spend' ? spend : undefined,
  })), mine: String(found.table._id) });
});

// What the guest may see of a quiz round. Correct answers are revealed only for questions already answered.
function quizView(round, { pointsThisVisit, earns }) {
  const answered = round.answers.length;
  return {
    roundId: String(round._id),
    status: round.status,
    total: round.questions.length,
    answered,
    score: round.answers.filter((a) => a.correct).length,
    points: round.points || 0,
    earnsPoints: earns,
    pointsPerCorrect: QUIZ_POINTS_PER_CORRECT,
    visitCap: GAME_POINTS_CAP_PER_VISIT,
    pointsThisVisit,
    questions: round.questions.map((q, i) => ({
      prompt: q.prompt,
      options: q.options,
      ...(i < answered ? { answerIndex: q.answerIndex, choice: round.answers[i].choice } : {}),
    })),
  };
}

// Starts a quiz, or resumes the open one for this visit. Questions come from this restaurant's menu.
router.post('/table/:token/games/quiz', async (req, res) => {
  const found = await tableByToken(req.params.token);
  if (!found) return res.status(404).json({ error: 'This table code is not valid.' });
  const { table, restaurant } = found;
  const session = table.sessionStartedAt || null;

  let round = await GameRound.findOne({ table: table._id, game: 'quiz', status: 'open' }).sort({ createdAt: -1 });
  // An open quiz from an earlier visit is stale: close it and start fresh.
  if (round && String(round.sessionStartedAt || '') !== String(session || '')) {
    round.status = 'abandoned';
    await round.save();
    round = null;
  }
  const created = !round;
  if (created) {
    const menu = await MenuItem.find({ restaurant: restaurant._id }).lean();
    const questions = buildQuiz(menu);
    if (!questions) {
      return res.status(409).json({ error: 'The menu needs a few more dishes before a quiz can start.' });
    }
    round = await GameRound.create({ restaurant: restaurant._id, table: table._id, game: 'quiz', sessionStartedAt: session, questions });
  }
  const pointsThisVisit = await visitGamePoints(table._id, session);
  res.status(created ? 201 : 200).json(quizView(round, { pointsThisVisit, earns: !!session }));
});

// Records one answer. Questions must be answered in order. The last answer awards points.
router.post('/table/:token/games/quiz/:roundId/answer', async (req, res) => {
  const found = await tableByToken(req.params.token);
  if (!found) return res.status(404).json({ error: 'This table code is not valid.' });
  const { table, restaurant } = found;
  if (!/^[a-f\d]{24}$/i.test(req.params.roundId)) return res.status(404).json({ error: 'This quiz is no longer available.' });
  const round = await GameRound.findOne({ _id: req.params.roundId, table: table._id, game: 'quiz' });
  if (!round || round.status !== 'open') return res.status(409).json({ error: 'This quiz has finished. Start a new one.' });

  const index = Math.floor(Number(req.body?.questionIndex));
  const choice = Math.floor(Number(req.body?.choice));
  if (index !== round.answers.length) return res.status(409).json({ error: 'Answer the questions in order.' });
  const question = round.questions[index];
  if (!question || !(choice >= 0 && choice < question.options.length)) {
    return res.status(400).json({ error: 'Pick one of the options.' });
  }

  const correct = choice === question.answerIndex;
  round.answers.push({ choice, correct });
  const finished = round.answers.length === round.questions.length;
  if (finished) {
    const score = round.answers.filter((a) => a.correct).length;
    let awarded = 0;
    if (round.sessionStartedAt) {
      const room = Math.max(0, GAME_POINTS_CAP_PER_VISIT - (await visitGamePoints(table._id, round.sessionStartedAt)));
      awarded = Math.min(score * QUIZ_POINTS_PER_CORRECT, room);
    }
    round.points = awarded;
    round.status = 'done';
    round.awardedAt = new Date();
    await round.save();
    await broadcastLeaderboard(restaurant._id);
    return res.json({ correct, answerIndex: question.answerIndex, finished: true, score, points: awarded });
  }
  await round.save();
  res.json({ correct, answerIndex: question.answerIndex, finished: false });
});

export default router;

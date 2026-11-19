import { Challenge, ChallengeAward, GameRound, Order, Restaurant, Table } from './models.js';
import { notifyPublic, notifyRestaurant, notifyTable } from './realtime.js';

// Quiz scoring. Points only count while a table has an open visit, and each visit is capped
// so the leaderboard cannot be farmed by playing quiz after quiz.
export const QUIZ_POINTS_PER_CORRECT = 2;
export const GAME_POINTS_CAP_PER_VISIT = 30;
export const QUIZ_QUESTIONS = 5;

function shuffle(list) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Builds a quiz from this restaurant's own menu. Returns null if the menu is too small for real questions.
export function buildQuiz(menu, count = QUIZ_QUESTIONS) {
  const pool = menu.filter((m) => m.available !== false);
  if (pool.length < 4) return null;
  const veg = pool.filter((m) => m.veg);
  const nonVeg = pool.filter((m) => !m.veg);
  const categories = [...new Set(pool.map((m) => m.category))];
  const preps = [...new Set(pool.map((m) => m.prepMinutes))];

  const makers = [];
  // Which dish is vegetarian?
  if (veg.length >= 1 && nonVeg.length >= 3) {
    makers.push(() => {
      const right = shuffle(veg)[0];
      const wrong = shuffle(nonVeg).slice(0, 3);
      return { prompt: 'Which of these dishes is vegetarian?', correct: right.name, others: wrong.map((w) => w.name), item: right._id };
    });
  }
  // Which section is this dish in?
  if (categories.length >= 2) {
    makers.push(() => {
      const item = shuffle(pool)[0];
      const others = shuffle(categories.filter((c) => c !== item.category)).slice(0, 3);
      return { prompt: `Which section of the menu is ${item.name} in?`, correct: item.category, others, item: item._id };
    });
  }
  // How long does this dish take?
  if (preps.length >= 2) {
    makers.push(() => {
      const item = shuffle(pool)[0];
      const others = new Set(preps.filter((p) => p !== item.prepMinutes));
      for (let step = 2; others.size < 3 && step < 30; step += 2) {
        others.add(item.prepMinutes + step);
      }
      return {
        prompt: `About how many minutes does ${item.name} take to prepare?`,
        correct: `${item.prepMinutes} min`,
        others: shuffle([...others]).slice(0, 3).map((p) => `${p} min`),
        item: item._id,
      };
    });
  }
  if (!makers.length) return null;

  const questions = [];
  const usedItems = new Set();
  let attempts = 0;
  while (questions.length < count && attempts < 80) {
    attempts++;
    const make = makers[attempts % makers.length];
    const q = make();
    if (q.others.length < 1 || usedItems.has(String(q.item || q.prompt))) continue;
    usedItems.add(String(q.item || q.prompt));
    const options = shuffle([q.correct, ...q.others.slice(0, 3)]);
    questions.push({ prompt: q.prompt, options, answerIndex: options.indexOf(q.correct) });
  }
  return questions.length >= 3 ? questions : null;
}

// Points this table has earned from games in its current visit.
export async function visitGamePoints(tableId, sessionStartedAt) {
  if (!sessionStartedAt) return 0;
  const rounds = await GameRound.find({ table: tableId, status: 'done', sessionStartedAt }).lean();
  return rounds.reduce((sum, r) => sum + (r.points || 0), 0);
}

// Items that count toward game progress: approved orders in the current table visit.
function sessionItems(orders) {
  const items = [];
  for (const order of orders) {
    if (order.status === 'rejected') continue;
    for (const item of order.items) {
      if (item.status === 'rejected' || item.status === 'cancelled') continue;
      items.push({ ...item, orderId: String(order._id) });
    }
  }
  return items;
}

// Progress of one challenge for one table visit.
export function progressFor(challenge, orders) {
  const items = sessionItems(orders);
  const approvedOrders = orders.filter((o) => o.status !== 'rejected' && o.status !== 'pending');
  let current = 0;
  if (challenge.kind === 'distinct_dishes') {
    current = new Set(items.map((i) => String(i.menuItem))).size;
  } else if (challenge.kind === 'category') {
    current = items
      .filter((i) => i.category === challenge.category)
      .reduce((sum, i) => sum + i.qty, 0);
  } else if (challenge.kind === 'orders_count') {
    current = approvedOrders.length;
  }
  return { current: Math.min(current, challenge.target), target: challenge.target };
}

// Awards any newly completed challenges. The unique index on ChallengeAward stops double awards.
export async function evaluateChallenges(restaurantId, tableId) {
  const table = await Table.findById(tableId).lean();
  if (!table || !table.sessionStartedAt) return;
  const orders = await Order.find({
    table: tableId,
    createdAt: { $gte: table.sessionStartedAt },
  }).lean();
  const challenges = await Challenge.find({ restaurant: restaurantId, active: true }).lean();
  const awarded = [];
  for (const challenge of challenges) {
    const { current, target } = progressFor(challenge, orders);
    if (current < target) continue;
    try {
      await ChallengeAward.create({
        restaurant: restaurantId,
        table: tableId,
        challenge: challenge._id,
        titleSnapshot: challenge.title,
        points: challenge.points,
        sessionStartedAt: table.sessionStartedAt,
      });
      awarded.push({ title: challenge.title, points: challenge.points });
    } catch (err) {
      if (err.code !== 11000) throw err; // 11000 = already awarded this visit
    }
  }
  if (awarded.length) {
    notifyTable(restaurantId, tableId, 'game:award', { awarded });
    await broadcastLeaderboard(restaurantId);
  }
}

// Ranks every table in the restaurant for the current game period.
export async function leaderboard(restaurantId) {
  const restaurant = await Restaurant.findById(restaurantId).lean();
  const since = restaurant.gamePeriodStart;
  const metric = restaurant.leaderboardMetric;
  const tables = await Table.find({ restaurant: restaurantId }).lean();
  const orders = await Order.find({
    restaurant: restaurantId,
    createdAt: { $gte: since },
    status: { $in: ['approved', 'closed'] },
  }).lean();
  const awards = await ChallengeAward.find({
    restaurant: restaurantId,
    awardedAt: { $gte: since },
  }).lean();
  const quizRounds = await GameRound.find({
    restaurant: restaurantId,
    status: 'done',
    awardedAt: { $gte: since },
  }).lean();

  const rows = tables.map((t) => {
    const tableOrders = orders.filter((o) => String(o.table) === String(t._id));
    const tableAwards = awards.filter((a) => String(a.table) === String(t._id));
    const tableQuiz = quizRounds.filter((r) => String(r.table) === String(t._id));
    const items = sessionItems(tableOrders);
    const dishes = new Set(items.map((i) => String(i.menuItem))).size;
    const spend = items.reduce((sum, i) => sum + i.price * i.qty, 0);
    return {
      tableId: String(t._id),
      tableNumber: t.number,
      status: t.status,
      orders: tableOrders.length,
      dishes,
      points:
        tableAwards.reduce((sum, a) => sum + (a.points || 0), 0) +
        tableQuiz.reduce((sum, r) => sum + (r.points || 0), 0),
      spend: Math.round(spend * 100) / 100,
    };
  });

  const primary = metric === 'spend' ? 'spend' : metric === 'orders' ? 'orders' : 'points';
  rows.sort((a, b) => b[primary] - a[primary] || b.points - a.points || b.orders - a.orders);
  rows.forEach((r, i) => (r.rank = i + 1));
  return { metric: primary, sinceISO: since, rows };
}

export async function broadcastLeaderboard(restaurantId) {
  const board = await leaderboard(restaurantId);
  notifyRestaurant(restaurantId, 'game:changed', {});
  notifyPublic(restaurantId, 'game:changed', { top: board.rows.slice(0, 10) });
}

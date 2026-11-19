// End-to-end check of the menu quiz API. Usage: node quiz-test.mjs <table-token>
const BASE = 'http://localhost:4000/api/public';
const token = process.argv[2];
let failed = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ` (${extra})` : ''}`);
  if (!ok) failed++;
};
const call = async (method, path, body) => {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
};

// 1. Fresh table with no order yet: quiz starts but earns nothing.
const start1 = await call('POST', `/table/${token}/games/quiz`);
check('quiz starts for a table with no order (201)', start1.status === 201, `status ${start1.status}`);
const r1 = start1.data;
check('quiz has 3 to 5 questions', r1.total >= 3 && r1.total <= 5, `total ${r1.total}`);
check('answers are not sent to the guest', r1.questions.every((q) => q.answerIndex === undefined));
check('no points earned before an order', r1.earnsPoints === false);

const again = await call('POST', `/table/${token}/games/quiz`);
check('starting again resumes the open quiz (200, same round)', again.status === 200 && again.data.roundId === r1.roundId);

const outOfOrder = await call('POST', `/table/${token}/games/quiz/${r1.roundId}/answer`, { questionIndex: 1, choice: 0 });
check('answering out of order is refused (409)', outOfOrder.status === 409, outOfOrder.data.error);

const badChoice = await call('POST', `/table/${token}/games/quiz/${r1.roundId}/answer`, { questionIndex: 0, choice: 99 });
check('an option that does not exist is refused (400)', badChoice.status === 400);

let score1 = 0;
for (let i = 0; i < r1.total; i++) {
  const res = await call('POST', `/table/${token}/games/quiz/${r1.roundId}/answer`, { questionIndex: i, choice: 0 });
  if (res.data.correct) score1++;
  if (i === 0) {
    check('first answer reveals the correct option', typeof res.data.answerIndex === 'number', `answerIndex ${res.data.answerIndex}`);
  }
  if (i === r1.total - 1) check('last answer finishes the quiz', res.data.finished === true);
}
const after = await call('POST', `/table/${token}/games/quiz`);
check('a finished quiz is not resumed; a new one starts', after.status === 201 && after.data.roundId !== r1.roundId);

// 2. Place an order: this starts the table's visit, so quiz points now count.
const menu = (await call('GET', `/table/${token}`)).data.menu;
const samosa = menu.find((m) => m.name.startsWith('Veg Samosa'));
const order = await call('POST', `/table/${token}/orders`, {
  nickname: 'Test',
  items: [{ menuItemId: samosa._id, qty: 1, selections: [] }],
});
check('order placed to open the visit', order.status === 201, order.data.error || '');

// 3. Play rounds in this visit until the cap is reached. Each round's points must follow the rules.
let totalAwarded = 0;
let rounds = 0;
while (rounds < 15) {
  const s = await call('POST', `/table/${token}/games/quiz`);
  const id = s.data.roundId;
  if (rounds === 0) check('quiz earns points once the visit has an order', s.data.earnsPoints === true);
  let score = 0;
  let last;
  for (let i = 0; i < s.data.total; i++) {
    last = await call('POST', `/table/${token}/games/quiz/${id}/answer`, { questionIndex: i, choice: 0 });
    if (last.data.correct) score++;
  }
  const expected = Math.min(score * 2, Math.max(0, 30 - totalAwarded));
  check(
    `round ${rounds + 1}: ${score} correct earns ${expected} points (capped at 30 per visit)`,
    last.data.points === expected,
    `got ${last.data.points}`
  );
  totalAwarded += last.data.points;
  rounds++;
  if (totalAwarded >= 30) break;
}
check('visit total never exceeds the cap of 30', totalAwarded <= 30, `total ${totalAwarded}`);

// 4. A round started after the cap still plays but earns nothing.
if (totalAwarded >= 30) {
  const capped = await call('POST', `/table/${token}/games/quiz`);
  let pts = 0;
  for (let i = 0; i < capped.data.total; i++) {
    const r = await call('POST', `/table/${token}/games/quiz/${capped.data.roundId}/answer`, { questionIndex: i, choice: 0 });
    pts = r.data.points ?? pts;
  }
  check('after the cap, quiz plays but awards 0 points', pts === 0, `got ${pts}`);
}

// 5. Leaderboard reflects the quiz points for this table.
const board = await call('GET', `/table/${token}/leaderboard`);
const mine = board.data.rows.find((r) => r.tableId === board.data.mine);
check('leaderboard includes quiz points for this table', mine && mine.points === totalAwarded, `board ${mine?.points}, awarded ${totalAwarded}`);

console.log(failed ? `\n${failed} check(s) failed` : '\nAll quiz checks passed');
process.exit(failed ? 1 : 0);

// Checks sizes, allergens, happy-hour pricing, serving hours and the reports API.
// Usage: node scripts/menu-reports-check.mjs <table-token-from-seed>   (run after npm run seed)
const BASE = 'http://localhost:4000/api';
const token = process.argv[2];
let failed = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ` (${extra})` : ''}`);
  if (!ok) failed++;
};
async function call(method, path, { body, auth, raw } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (auth) headers.Authorization = `Bearer ${auth}`;
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  if (raw) return { status: res.status, type: res.headers.get('content-type') || '', text: await res.text() };
  return { status: res.status, data: await res.json().catch(() => ({})) };
}
const login = async (email, password) => (await call('POST', '/auth/login', { body: { email, password } })).data.token;

const owner = await login('owner@spicegarden.test', 'owner123');
const staff = await login('staff@spicegarden.test', 'staff123');

// Guest menu: prices and flags for this moment.
const table = (await call('GET', `/public/table/${token}`)).data;
const menu = table.menu;
const now = new Date();
const hour = now.getHours();
const lassi = menu.find((m) => m.name === 'Mango Lassi');
const chai = menu.find((m) => m.name === 'Masala Chai');
const samosa = menu.find((m) => m.name.startsWith('Veg Samosa'));

check('guest sees sizes with their own prices', lassi.sizes.length === 2 && lassi.sizes[1].price === 160, `Large ${lassi.sizes[1]?.price}`);
const hhOn = hour >= 15 && hour < 18;
check('happy hour applies only inside its window', chai.happyHourActive === hhOn, `hour ${hour}`);
check('happy hour price is 20% off', chai.displayPrice === (hhOn ? 40 : 50), `displayPrice ${chai.displayPrice}`);
check('allergens and badges reach the guest', Array.isArray(samosa.allergens) && lassi.bestseller === true);

// Ordering with sizes.
const noSize = await call('POST', `/public/table/${token}/orders`, { body: { items: [{ menuItemId: lassi._id, qty: 1 }] } });
check('sized dish without a size is refused', noSize.status === 400, noSize.data.error);
const badSize = await call('POST', `/public/table/${token}/orders`, { body: { items: [{ menuItemId: lassi._id, qty: 1, size: 'Huge' }] } });
check('unknown size is refused', badSize.status === 400, badSize.data.error);
const good = await call('POST', `/public/table/${token}/orders`, { body: { items: [{ menuItemId: lassi._id, qty: 1, size: 'Large' }] } });
check('sized order is accepted (201)', good.status === 201, good.data.error || '');
const orders = (await call('GET', '/r/orders', { auth: staff })).data;
const list = orders.orders || orders;
const line = list.flatMap((o) => o.items || []).find((i) => i.name === 'Mango Lassi (Large)');
check('kitchen sees the size in the dish name', !!line);
check('the line is charged the Large price', line && line.price === 160, `price ${line?.price}`);

// Serving hours.
const shut = (hour + 2) % 24;
const closedFrom = shut;
const closedTo = (hour + 3) % 24;
const made = await call('POST', '/r/menu', {
  auth: owner,
  body: { name: 'Late Snack Check', category: 'Test', price: 99, availableFrom: closedFrom, availableTo: closedTo },
});
check('menu item with serving hours is created', made.status === 201, made.data.error || '');
const snackId = made.data.item?._id;
const fresh = (await call('GET', `/public/table/${token}`)).data.menu.find((m) => m.name === 'Late Snack Check');
check('guest menu marks the dish as not served right now', fresh && fresh.servingNow === false);
const shutOrder = await call('POST', `/public/table/${token}/orders`, { body: { items: [{ menuItemId: snackId, qty: 1 }] } });
check('ordering outside serving hours is refused (409)', shutOrder.status === 409, shutOrder.data.error);

// Validation.
const badAllergen = await call('PATCH', `/r/menu/${snackId}`, { auth: owner, body: { allergens: ['dragonfruit'] } });
check('unknown allergen is refused (400)', badAllergen.status === 400, badAllergen.data.error);
const badPct = await call('PATCH', `/r/menu/${snackId}`, { auth: owner, body: { happyHourPct: 150 } });
check('happy hour above 90% is refused (400)', badPct.status === 400, badPct.data.error);
const badHour = await call('PATCH', `/r/menu/${snackId}`, { auth: owner, body: { availableFrom: 25 } });
check('an hour above 23 is refused (400)', badHour.status === 400, badHour.data.error);
const edit = await call('PATCH', `/r/menu/${snackId}`, {
  auth: owner,
  body: { sizes: [{ label: 'Small', price: 60 }, { label: 'Big', price: 110 }], allergens: ['gluten'], vegan: true },
});
check('staff edit saves sizes, allergens and labels', edit.status === 200 && edit.data.item.sizes.length === 2 && edit.data.item.vegan === true);
await call('DELETE', `/r/menu/${snackId}`, { auth: owner });

// Reports.
const from = new Date(Date.now() - 6 * 864e5);
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const today = ymd(new Date());
const week = ymd(from);
const summary = await call('GET', `/r/reports/summary?from=${week}&to=${today}`, { auth: owner });
check('owner gets the sales summary (200)', summary.status === 200, summary.data.error || '');
check('summary has totals, payments, items, hours and days',
  summary.data.totals && summary.data.payments && Array.isArray(summary.data.topItems) && summary.data.hours.length === 24 && summary.data.days.length === 7);
check('summary covers the chosen range', summary.data.from === week && summary.data.to === today);
const staffSummary = await call('GET', `/r/reports/summary?from=${week}&to=${today}`, { auth: staff });
check('floor staff cannot open reports (403)', staffSummary.status === 403, `status ${staffSummary.status}`);
const backwards = await call('GET', `/r/reports/summary?from=${today}&to=${week}`, { auth: owner });
check('a backwards date range is refused (400)', backwards.status === 400);
const tooLong = await call('GET', `/r/reports/summary?from=2020-01-01&to=2024-01-01`, { auth: owner });
check('a range over a year is refused (400)', tooLong.status === 400);
const csv = await call('GET', `/r/reports/sales.csv?from=${week}&to=${today}`, { auth: owner, raw: true });
check('bills CSV downloads with the right type', csv.status === 200 && csv.type.startsWith('text/csv'), csv.type);
check('bills CSV has a header row', csv.text.replace(/^﻿/, '').startsWith('Closed at,Invoice,Table'));
const items = await call('GET', `/r/reports/items.csv?from=${week}&to=${today}`, { auth: owner, raw: true });
check('dishes CSV downloads', items.status === 200 && items.text.includes('Dish,Category'));
const noAuth = await call('GET', `/r/reports/items.csv?from=${week}&to=${today}`, { raw: true });
check('reports refuse anonymous visitors', noAuth.status === 401, `status ${noAuth.status}`);

console.log(failed ? `\n${failed} check(s) failed` : '\nAll menu and report checks passed');
process.exit(failed ? 1 : 0);

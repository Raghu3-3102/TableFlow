// End-to-end check of the core flow against a running API (npm start) with seeded data.
// Usage: node scripts/smoke.mjs <table-qr-token>
const API = process.env.API || 'http://localhost:4000/api';
const token = process.argv[2];
if (!token) {
  console.error('Pass a table QR token from the seed output.');
  process.exit(1);
}

const check = (label, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? ` (${extra})` : ''}`);
  if (!ok) process.exitCode = 1;
};
const call = async (method, path, body, jwt) => {
  const res = await fetch(API + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(jwt ? { Authorization: `Bearer ${jwt}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
};

const login = async (email, password) => (await call('POST', '/auth/login', { email, password })).data.token;

const guest = await call('GET', `/public/table/${token}`);
check('guest menu loads', guest.status === 200, `${guest.data.menu?.length} items`);
const paneer = guest.data.menu.find((m) => m.name === 'Paneer Tikka');
const dessert = guest.data.menu.find((m) => m.name === 'Gulab Jamun');

const bad = await call('POST', `/public/table/${token}/orders`, { items: [{ menuItemId: paneer._id, qty: 1 }] });
check('checklist required: order without spice level is refused', bad.status === 400, bad.data.error);

const placed = await call('POST', `/public/table/${token}/orders`, {
  nickname: 'Test',
  items: [{ menuItemId: paneer._id, qty: 2, selections: [{ label: 'Spice level', choice: 'Hot' }] }],
});
check('guest order placed', placed.status === 201, placed.data.orderId);
const orderId = placed.data.orderId;

const owner = await login('owner@spicegarden.test', 'owner123');
const staff = await login('staff@spicegarden.test', 'staff123');
const cook = await login('cook@spicegarden.test', 'cook123');
const manager = await login('manager@spicegarden.test', 'manager123');
const admin = await login('admin@tableflow.test', 'admin123');
check('all five logins work', [owner, staff, cook, manager, admin].every(Boolean));

const queue = await call('GET', '/r/orders?status=pending', null, staff);
check('order appears in staff approval queue', queue.data.orders?.some((o) => String(o._id) === orderId));

const approved = await call('PATCH', `/r/orders/${orderId}/approve`, { items: [] }, staff);
check('staff approves order', approved.status === 200 && approved.data.order.status === 'approved');
const itemId = approved.data.order.items[0]._id;

const cookTooEarly = await call('PATCH', `/r/orders/${orderId}/items/${itemId}`, { status: 'ready' }, cook);
check('kitchen cannot skip preparing', cookTooEarly.status === 409);

const prep = await call('PATCH', `/r/orders/${orderId}/items/${itemId}`, { status: 'preparing' }, cook);
check('cook starts item', prep.status === 200);

const noTicks = await call('PATCH', `/r/orders/${orderId}/items/${itemId}`, { status: 'ready', checklistTicks: [] }, cook);
check('ready blocked until checklist ticked', noTicks.status === 409, noTicks.data.error);

const ready = await call('PATCH', `/r/orders/${orderId}/items/${itemId}`, { status: 'ready', checklistTicks: ['Spice level'] }, cook);
check('cook marks ready after checklist', ready.status === 200);

const served = await call('PATCH', `/r/orders/${orderId}/items/${itemId}`, { status: 'served' }, staff);
check('staff marks served', served.status === 200);

const call1 = await call('POST', `/public/table/${token}/call`, { kind: 'water' });
check('guest calls waiter', call1.status === 201 || call1.data.already === true);
const calls = await call('GET', '/r/calls', null, staff);
check('call appears for staff', calls.data.calls?.length >= 1);

const board = await call('GET', `/public/table/${token}/leaderboard`);
check('public leaderboard loads', board.status === 200, `${board.data.rows?.length} tables`);

const tableNumber = guest.data.table.number;
const tables = (await call('GET', '/r/tables', null, staff)).data.tables;
const table = tables.find((t) => t.number === tableNumber);
const billRes = await call('POST', `/r/tables/${table._id}/bill`, null, staff);
check('bill created from served items', billRes.status === 201 || billRes.status === 200, `total ${billRes.data.bill?.total}`);
const b = billRes.data.bill;

const overpay = await call('POST', `/r/bills/${b._id}/payments`, { amount: b.total + 500, method: 'upi' }, staff);
check('overpayment refused', overpay.status === 400, overpay.data.error);

const half = await call('POST', `/r/bills/${b._id}/payments`, { amount: Math.round((b.total / 2) * 100) / 100, method: 'cash', shareLabel: 'Share 1 of 2' }, staff);
check('partial payment recorded, bill stays open', half.status === 200 && half.data.bill.status === 'open');

const rest = await call('POST', `/r/bills/${b._id}/payments`, { amount: half.data.bill.total - half.data.bill.paid, method: 'upi', shareLabel: 'Share 2 of 2' }, staff);
check('final payment closes bill and frees table', rest.status === 200 && rest.data.bill.status === 'paid');

const after = await call('GET', `/public/table/${token}/status`);
check('table is free after payment', after.data.table.status === 'free');

const dash = await call('GET', '/r/overview', null, manager);
check('manager dashboard overview loads', dash.status === 200, `sales ₹${dash.data.today?.sales}`);

const cookBlocked = await call('GET', '/r/overview', null, cook);
check('cook cannot open owner/manager overview', cookBlocked.status === 403);

const platform = await call('GET', '/admin/restaurants', null, admin);
check('platform dashboard lists restaurants', platform.status === 200 && platform.data.restaurants.length >= 1, `collected ₹${platform.data.totals?.collected}`);

const ownerAsAdmin = await call('GET', '/admin/restaurants', null, owner);
check('owner cannot open platform dashboard', ownerAsAdmin.status === 403);

const reset = await call('POST', '/r/game/reset', null, manager);
check('manager resets the game period', reset.status === 200);

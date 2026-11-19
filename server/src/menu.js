// Shared menu rules: sizes, allergens, happy-hour pricing and serving hours.
// Times are the server's local clock, so the restaurant's server must run on local time.
export const ALLERGENS = ['milk', 'egg', 'nuts', 'gluten', 'soy', 'fish', 'shellfish', 'sesame'];

export class MenuError extends Error {}

const round2 = (n) => Math.round(n * 100) / 100;

// True when `hour` is inside [from, to). A window may wrap past midnight, for example 22 to 2.
// Missing bounds mean "all day".
export function inHours(hour, from, to) {
  if (from == null || to == null || from === to) return true;
  return from < to ? hour >= from && hour < to : hour >= from || hour < to;
}

export function servingNow(item, now = new Date()) {
  return inHours(now.getHours(), item.availableFrom, item.availableTo);
}

export function happyHourNow(item, now = new Date()) {
  if (!(item.happyHourPct > 0) || item.happyHourFrom == null || item.happyHourTo == null) return false;
  return inHours(now.getHours(), item.happyHourFrom, item.happyHourTo);
}

// The price a guest pays for one unit right now: size price (or base price), less any happy-hour discount.
export function priceFor(item, size = '', now = new Date()) {
  const sized = size ? (item.sizes || []).find((s) => s.label === size) : null;
  const base = sized ? sized.price : item.price;
  const pct = happyHourNow(item, now) ? item.happyHourPct : 0;
  return round2(base * (1 - pct / 100));
}

// Guest view of one dish, priced and checked for the current moment.
export function guestDish(item, now = new Date()) {
  return {
    ...item,
    basePrice: item.price,
    displayPrice: priceFor(item, '', now),
    happyHourActive: happyHourNow(item, now),
    servingNow: servingNow(item, now),
    sizes: (item.sizes || []).map((s) => ({ label: s.label, basePrice: s.price, price: priceFor(item, s.label, now) })),
  };
}

const hourField = (v) => {
  if (v === '' || v == null) return null;
  const h = Math.floor(Number(v));
  if (!(h >= 0 && h <= 23)) throw new MenuError('Hours must be between 0 and 23.');
  return h;
};

// Cleans the menu fields a staff member sent. Only keys that were sent are returned, so the same
// function serves both create and update.
export function cleanMenuFields(body = {}) {
  const out = {};
  if ('sizes' in body) {
    const list = (Array.isArray(body.sizes) ? body.sizes : []).filter((s) => s && String(s.label || '').trim());
    out.sizes = list.map((s) => {
      const price = Number(s.price);
      if (!(price >= 0)) throw new MenuError(`Give ${String(s.label).trim()} a valid price.`);
      return { label: String(s.label).trim().slice(0, 30), price };
    });
    const labels = out.sizes.map((s) => s.label.toLowerCase());
    if (new Set(labels).size !== labels.length) throw new MenuError('Each size needs its own name.');
  }
  if ('allergens' in body) {
    const list = Array.isArray(body.allergens) ? body.allergens : [];
    const bad = list.filter((a) => !ALLERGENS.includes(a));
    if (bad.length) throw new MenuError(`Unknown allergen: ${bad[0]}.`);
    out.allergens = [...new Set(list)];
  }
  for (const key of ['vegan', 'bestseller', 'featured']) {
    if (key in body) out[key] = Boolean(body[key]);
  }
  if ('availableFrom' in body) out.availableFrom = hourField(body.availableFrom);
  if ('availableTo' in body) out.availableTo = hourField(body.availableTo);
  if ('happyHourPct' in body) {
    const pct = body.happyHourPct === '' || body.happyHourPct == null ? 0 : Number(body.happyHourPct);
    if (!(pct >= 0 && pct <= 90)) throw new MenuError('Happy hour discount must be between 0 and 90 percent.');
    out.happyHourPct = pct;
  }
  if ('happyHourFrom' in body) out.happyHourFrom = hourField(body.happyHourFrom);
  if ('happyHourTo' in body) out.happyHourTo = hourField(body.happyHourTo);
  return out;
}

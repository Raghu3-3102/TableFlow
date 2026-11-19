import { Restaurant } from './models.js';

const round2 = (n) => Math.round(n * 100) / 100;

// Orders that count toward a bill: anything approved and not rejected or cancelled.
export function billableItems(orders) {
  const items = [];
  for (const order of orders) {
    for (const item of order.items) {
      if (item.status === 'rejected' || item.status === 'cancelled') continue;
      items.push({ ...item, orderId: order._id });
    }
  }
  return items;
}

// GST rule used here: a discount shown on the invoice is deducted first, then service charge and GST
// are calculated on the discounted (taxable) value.
export function computeBill(subtotal, restaurant, discount = 0) {
  const sub = round2(subtotal);
  const disc = round2(Math.min(Math.max(0, discount), sub));
  const taxable = round2(sub - disc);
  const serviceCharge = round2((taxable * (restaurant.serviceChargePct || 0)) / 100);
  const tax = round2(((taxable + serviceCharge) * (restaurant.taxPct || 0)) / 100);
  const total = round2(taxable + serviceCharge + tax);
  return { subtotal: sub, discount: disc, taxable, serviceCharge, tax, total };
}

export function computeTotals(items, restaurant, discount = 0) {
  const subtotal = items.reduce((sum, i) => sum + i.price * i.qty, 0);
  return computeBill(subtotal, restaurant, discount);
}

// Atomically increments the restaurant's invoice counter so numbers never repeat.
export async function nextInvoiceNo(restaurantId) {
  const r = await Restaurant.findByIdAndUpdate(
    restaurantId,
    { $inc: { invoiceCounter: 1 } },
    { new: true }
  ).lean();
  const year = new Date().getFullYear();
  return `${r.invoicePrefix}/${year}/${String(r.invoiceCounter).padStart(5, '0')}`;
}

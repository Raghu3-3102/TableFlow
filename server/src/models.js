import mongoose from 'mongoose';

const { Schema, model } = mongoose;
const ObjectId = Schema.Types.ObjectId;

const restaurantSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    phone: String,
    gstin: String,
    address: String,
    invoicePrefix: { type: String, default: 'INV' },
    invoiceCounter: { type: Number, default: 0 },
    taxPct: { type: Number, default: 5 },
    serviceChargePct: { type: Number, default: 0 },
    managerDiscountCapPct: { type: Number, default: 10 },
    approvalMode: { type: String, enum: ['manual', 'auto'], default: 'manual' },
    autoApproveSeconds: { type: Number, default: 60 },
    leaderboardMetric: { type: String, enum: ['orders', 'points', 'spend'], default: 'points' },
    gamePeriodStart: { type: Date, default: () => new Date() },
    subscriptionStatus: { type: String, enum: ['active', 'suspended'], default: 'active' },
  },
  { timestamps: true }
);

const userSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true },
    role: { type: String, enum: ['admin', 'owner', 'manager', 'staff', 'cook'], required: true },
    restaurant: { type: ObjectId, ref: 'Restaurant', default: null, index: true },
    active: { type: Boolean, default: true },
  },
  { timestamps: true }
);

const tableSchema = new Schema(
  {
    restaurant: { type: ObjectId, ref: 'Restaurant', required: true, index: true },
    number: { type: String, required: true, trim: true },
    qrToken: { type: String, required: true, unique: true },
    status: { type: String, enum: ['free', 'occupied', 'billing'], default: 'free' },
    sessionStartedAt: { type: Date, default: null },
  },
  { timestamps: true }
);
tableSchema.index({ restaurant: 1, number: 1 }, { unique: true });

const menuItemSchema = new Schema(
  {
    restaurant: { type: ObjectId, ref: 'Restaurant', required: true, index: true },
    name: { type: String, required: true, trim: true },
    category: { type: String, default: 'General', trim: true },
    description: String,
    price: { type: Number, required: true, min: 0 },
    veg: { type: Boolean, default: true },
    prepMinutes: { type: Number, default: 10, min: 1 },
    available: { type: Boolean, default: true },
    sizes: [{ label: { type: String, required: true }, price: { type: Number, required: true, min: 0 }, _id: false }],
    allergens: [String],
    vegan: { type: Boolean, default: false },
    bestseller: { type: Boolean, default: false },
    featured: { type: Boolean, default: false },
    availableFrom: Number,
    availableTo: Number,
    happyHourPct: { type: Number, default: 0 },
    happyHourFrom: Number,
    happyHourTo: Number,
    checklist: [
      {
        label: { type: String, required: true },
        options: [String],
        required: { type: Boolean, default: false },
      },
    ],
  },
  { timestamps: true }
);

const orderItemSchema = new Schema(
  {
    menuItem: { type: ObjectId, ref: 'MenuItem' },
    name: { type: String, required: true },
    category: String,
    price: { type: Number, required: true },
    qty: { type: Number, required: true, min: 1 },
    size: String,
    notes: String,
    selections: [{ label: String, choice: String }],
    checklistTicks: [String],
    status: {
      type: String,
      enum: ['pending', 'approved', 'preparing', 'ready', 'served', 'rejected', 'cancelled'],
      default: 'pending',
    },
    prepMinutes: { type: Number, default: 10 },
    startedAt: Date,
    readyAt: Date,
  },
  { _id: true }
);

const orderSchema = new Schema(
  {
    restaurant: { type: ObjectId, ref: 'Restaurant', required: true, index: true },
    table: { type: ObjectId, ref: 'Table', required: true, index: true },
    tableNumber: String,
    nickname: { type: String, trim: true, maxlength: 20 },
    items: [orderItemSchema],
    status: { type: String, enum: ['pending', 'approved', 'rejected', 'closed'], default: 'pending', index: true },
    approvedBy: { type: ObjectId, ref: 'User' },
    approvedAt: Date,
    rejectReason: String,
  },
  { timestamps: true }
);

const challengeSchema = new Schema(
  {
    restaurant: { type: ObjectId, ref: 'Restaurant', required: true, index: true },
    title: { type: String, required: true, trim: true },
    kind: { type: String, enum: ['distinct_dishes', 'category', 'orders_count'], required: true },
    target: { type: Number, default: 1, min: 1 },
    category: String,
    points: { type: Number, default: 10, min: 1 },
    active: { type: Boolean, default: true },
  },
  { timestamps: true }
);

const challengeAwardSchema = new Schema(
  {
    restaurant: { type: ObjectId, ref: 'Restaurant', required: true, index: true },
    table: { type: ObjectId, ref: 'Table', required: true, index: true },
    challenge: { type: ObjectId, ref: 'Challenge', required: true },
    titleSnapshot: String,
    points: Number,
    sessionStartedAt: { type: Date, required: true },
    awardedAt: { type: Date, default: () => new Date() },
  },
  { timestamps: false }
);
challengeAwardSchema.index({ table: 1, challenge: 1, sessionStartedAt: 1 }, { unique: true });

const callSchema = new Schema(
  {
    restaurant: { type: ObjectId, ref: 'Restaurant', required: true, index: true },
    table: { type: ObjectId, ref: 'Table', required: true },
    tableNumber: String,
    kind: { type: String, enum: ['water', 'cutlery', 'bill', 'help', 'other'], default: 'help' },
    note: { type: String, maxlength: 140 },
    status: { type: String, enum: ['open', 'acknowledged'], default: 'open', index: true },
    acknowledgedBy: { type: ObjectId, ref: 'User' },
    acknowledgedAt: Date,
  },
  { timestamps: true }
);

const billSchema = new Schema(
  {
    restaurant: { type: ObjectId, ref: 'Restaurant', required: true, index: true },
    table: { type: ObjectId, ref: 'Table', required: true },
    tableNumber: String,
    orders: [{ type: ObjectId, ref: 'Order' }],
    invoiceNo: String,
    subtotal: { type: Number, default: 0 },
    discount: { type: Number, default: 0 },
    taxable: { type: Number, default: 0 },
    discountType: { type: String, enum: ['amount', 'percent', null], default: null },
    discountValue: { type: Number, default: 0 },
    discountReason: { type: String, trim: true, maxlength: 140 },
    discountBy: { type: ObjectId, ref: 'User' },
    discountByName: String,
    tax: { type: Number, default: 0 },
    serviceCharge: { type: Number, default: 0 },
    total: { type: Number, default: 0 },
    paid: { type: Number, default: 0 },
    status: { type: String, enum: ['open', 'paid'], default: 'open', index: true },
    payments: [
      {
        amount: Number,
        method: { type: String, enum: ['cash', 'upi', 'card'] },
        shareLabel: String,
        reference: String,
        recordedBy: { type: ObjectId, ref: 'User' },
        paidAt: { type: Date, default: () => new Date() },
      },
    ],
    closedAt: Date,
  },
  { timestamps: true }
);

const auditSchema = new Schema(
  {
    restaurant: { type: ObjectId, ref: 'Restaurant', required: true, index: true },
    actor: { type: ObjectId, ref: 'User' },
    actorName: String,
    actorRole: String,
    action: { type: String, required: true },
    detail: String,
    at: { type: Date, default: () => new Date(), index: true },
  },
  { versionKey: false }
);

const feedbackSchema = new Schema(
  {
    restaurant: { type: ObjectId, ref: 'Restaurant', required: true, index: true },
    table: { type: ObjectId, ref: 'Table' },
    tableNumber: String,
    bill: { type: ObjectId, ref: 'Bill', unique: true, sparse: true },
    rating: { type: Number, min: 1, max: 5, required: true },
    comment: { type: String, maxlength: 280 },
    nickname: String,
  },
  { timestamps: true }
);

export const AuditLog = model('AuditLog', auditSchema);
export const Feedback = model('Feedback', feedbackSchema);
export const Restaurant = model('Restaurant', restaurantSchema);
export const User = model('User', userSchema);
export const Table = model('Table', tableSchema);
export const MenuItem = model('MenuItem', menuItemSchema);
export const Order = model('Order', orderSchema);
export const Challenge = model('Challenge', challengeSchema);
export const ChallengeAward = model('ChallengeAward', challengeAwardSchema);
export const Call = model('Call', callSchema);
// One play of a table game. Quiz answers stay on the server; the guest only sees each answer after choosing it.
const gameRoundSchema = new Schema(
  {
    restaurant: { type: ObjectId, ref: 'Restaurant', required: true, index: true },
    table: { type: ObjectId, ref: 'Table', required: true, index: true },
    game: { type: String, enum: ['quiz'], required: true },
    sessionStartedAt: Date,
    questions: [{ prompt: String, options: [String], answerIndex: Number }],
    answers: [{ choice: Number, correct: Boolean }],
    status: { type: String, enum: ['open', 'done', 'abandoned'], default: 'open', index: true },
    points: { type: Number, default: 0 },
    awardedAt: Date,
  },
  { timestamps: true }
);

export const GameRound = model('GameRound', gameRoundSchema);
export const Bill = model('Bill', billSchema);

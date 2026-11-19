import cors from 'cors';
import express from 'express';
import http from 'node:http';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import { Server } from 'socket.io';
import { config } from './config.js';
import { setIO } from './realtime.js';
import { Order, Restaurant, Table, User } from './models.js';
import authRoutes from './routes/auth.js';
import adminRoutes from './routes/admin.js';
import restaurantRoutes, { approveOrder } from './routes/restaurant.js';
import publicRoutes from './routes/public.js';

const app = express();
app.use(cors({ origin: config.clientOrigin }));
app.use(express.json({ limit: '100kb' }));

app.get('/api/health', (req, res) => res.json({ ok: true, db: mongoose.connection.readyState === 1 }));
app.use('/api/auth', authRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/r', restaurantRoutes);
app.use('/api/public', publicRoutes);

// Last-resort error handler so the app never leaks stack traces to guests.
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'The request was not valid JSON.' });
  console.error(err);
  res.status(err.status || 500).json({ error: err.expose ? err.message : 'Something went wrong. Please try again.' });
});

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: config.clientOrigin } });
setIO(io);

// Sockets: staff send their JWT; guests send their table QR token.
io.on('connection', async (socket) => {
  const { token, table } = socket.handshake.auth || {};
  try {
    if (token) {
      const payload = jwt.verify(token, config.jwtSecret);
      const user = await User.findById(payload.sub).lean();
      if (user?.active && user.restaurant) socket.join(`r:${user.restaurant}`);
    } else if (table) {
      const t = await Table.findOne({ qrToken: String(table) }).lean();
      if (t) {
        socket.join(`t:${t._id}`);
        socket.join(`p:${t.restaurant}`);
      }
    }
  } catch {
    // Bad or expired token: the socket stays connected but gets no room events.
  }
});

// Auto-approve: restaurants on auto mode approve orders that wait longer than their limit.
setInterval(async () => {
  try {
    const autoRestaurants = await Restaurant.find({ approvalMode: 'auto' }).lean();
    for (const r of autoRestaurants) {
      const cutoff = new Date(Date.now() - r.autoApproveSeconds * 1000);
      const waiting = await Order.find({ restaurant: r._id, status: 'pending', createdAt: { $lte: cutoff } });
      for (const order of waiting) await approveOrder(order, { approverId: null });
    }
  } catch (err) {
    console.error('auto-approve failed', err.message);
  }
}, 10000);

async function start() {
  await mongoose.connect(config.mongoUri);
  console.log('MongoDB connected');
  server.listen(config.port, () => console.log(`TableFlow API on http://localhost:${config.port}`));
}

start().catch((err) => {
  console.error('Failed to start:', err.message);
  process.exit(1);
});

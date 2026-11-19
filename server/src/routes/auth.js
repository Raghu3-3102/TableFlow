import bcrypt from 'bcryptjs';
import { Router } from 'express';
import { requireAuth, signToken } from '../auth.js';
import { Restaurant, User } from '../models.js';

const router = Router();

function publicUser(user, restaurant) {
  return {
    id: String(user._id),
    name: user.name,
    email: user.email,
    role: user.role,
    restaurant: user.restaurant ? { id: String(user.restaurant), name: restaurant?.name || '' } : null,
  };
}

router.post('/login', async (req, res) => {
  const { email = '', password = '' } = req.body || {};
  const user = await User.findOne({ email: String(email).toLowerCase().trim() });
  if (!user || !user.active || !(await bcrypt.compare(String(password), user.passwordHash))) {
    return res.status(401).json({ error: 'Email or password is wrong.' });
  }
  const restaurant = user.restaurant ? await Restaurant.findById(user.restaurant).lean() : null;
  if (restaurant && restaurant.subscriptionStatus === 'suspended') {
    return res.status(403).json({ error: 'This restaurant account is suspended. Contact TableFlow support.' });
  }
  res.json({ token: signToken(user), user: publicUser(user, restaurant) });
});

router.get('/me', requireAuth, async (req, res) => {
  const user = await User.findById(req.user.id).lean();
  const restaurant = user.restaurant ? await Restaurant.findById(user.restaurant).lean() : null;
  res.json({ user: publicUser(user, restaurant) });
});

export default router;

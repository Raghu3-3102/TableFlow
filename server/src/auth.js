import jwt from 'jsonwebtoken';
import { config } from './config.js';
import { User } from './models.js';

export function signToken(user) {
  return jwt.sign(
    { sub: String(user._id), role: user.role, restaurant: user.restaurant ? String(user.restaurant) : null },
    config.jwtSecret,
    { expiresIn: '12h' }
  );
}

// Verifies the bearer token and loads the user fresh, so suspended users lose access at once.
export async function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Please sign in.' });
  try {
    const payload = jwt.verify(token, config.jwtSecret);
    const user = await User.findById(payload.sub).lean();
    if (!user || !user.active) return res.status(401).json({ error: 'Your account is not active.' });
    req.user = {
      id: String(user._id),
      name: user.name,
      role: user.role,
      restaurant: user.restaurant ? String(user.restaurant) : null,
    };
    next();
  } catch {
    return res.status(401).json({ error: 'Your session has ended. Please sign in again.' });
  }
}

export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Your role cannot do this.' });
    }
    if (req.user.role !== 'admin' && !req.user.restaurant) {
      return res.status(403).json({ error: 'No restaurant is linked to this account.' });
    }
    next();
  };
}

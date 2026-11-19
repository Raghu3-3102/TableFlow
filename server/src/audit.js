import { AuditLog } from './models.js';

// Records who did what. Failures are logged but never block the action itself.
export async function audit(restaurantId, actor, action, detail = '') {
  try {
    await AuditLog.create({
      restaurant: restaurantId,
      actor: actor?.id || null,
      actorName: actor?.name || 'System',
      actorRole: actor?.role || 'system',
      action,
      detail: String(detail).slice(0, 300),
    });
  } catch (err) {
    console.error('audit failed:', err.message);
  }
}

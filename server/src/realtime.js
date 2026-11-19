// Holds the Socket.IO server so any route can announce a change.
// Rooms: r:<restaurantId> (staff dashboards), t:<tableId> (one guest table), p:<restaurantId> (public leaderboard).
let io = null;

export function setIO(server) {
  io = server;
}

export function notifyRestaurant(restaurantId, event, payload = {}) {
  if (!io) return;
  io.to(`r:${restaurantId}`).emit(event, payload);
}

export function notifyTable(restaurantId, tableId, event, payload = {}) {
  if (!io) return;
  io.to(`t:${tableId}`).emit(event, payload);
  io.to(`r:${restaurantId}`).emit(event, { tableId, ...payload });
}

export function notifyPublic(restaurantId, event, payload = {}) {
  if (!io) return;
  io.to(`p:${restaurantId}`).emit(event, payload);
}

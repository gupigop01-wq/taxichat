// Registry for the Socket.io server instance so REST controllers can emit
// the same events as the socket layer
let ioInstance = null;

const setIo = (io) => {
  ioInstance = io;
};

const getIo = () => ioInstance;

// Emits the side effects returned by the order state machine
const emitOrderEvents = (sideEffects = []) => {
  const io = getIo();
  if (!io) return;
  for (const effect of sideEffects) {
    io.to(effect.room).emit(effect.event, effect.payload);
  }
};

// Drops every live socket of a user (e.g. right after a ban)
const disconnectUser = (userId) => {
  const io = getIo();
  if (!io || !userId) return;
  io.in(`user:${userId}`).disconnectSockets(true);
};

module.exports = { setIo, getIo, emitOrderEvents, disconnectUser };

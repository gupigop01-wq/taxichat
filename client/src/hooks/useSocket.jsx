import { useSelector } from "react-redux";
import { io } from "socket.io-client";

const socket = io();
// Debug-only: inspectable from DevTools. Cracket up in dev builds only —
// in production builds NODE_ENV is inlined and this branch is eliminated.
if (typeof window !== "undefined" && process.env.NODE_ENV === "development") {
  window.__bombilaSocket = socket;
}

// Rejoin the membership rooms on every (re)connection: after a sleep or a
// network switch the server forgets the room membership, and without
// user:online the phone silently stops receiving order:new / order:status.
socket.on("connect", () => {
  socket.emit("user:online");
});

// After a successful login the cookie exists, but the socket may have connected
// anonymously before it. Reconnect so the handshake carries the cookie and the
// server binds the user and joins the membership rooms.
export const reconnectSocket = () => {
  if (socket.connected) socket.disconnect();
  socket.connect();
};

const useSocket = () => {
  const userId = useSelector((state) => state.userReducer.user._id);

  const socketEmit = (action, payload, fn) => {
    socket.emit(action, payload, fn);
  };

  const socketListen = (action, fn) => {
    socket.on(action, fn);
  };

  return { socketEmit, socketListen, userId, socket };
};

export default useSocket;

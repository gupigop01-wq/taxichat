import { configureStore } from "@reduxjs/toolkit";
import authReducer from "./authSlice";
import notificationReducer from "./notificationSlice";

// Only the slices the taxi workspace uses. The legacy messenger slices
// (chat, chatList, contacts, userProfile, sidebar, socket, modal) went away
// with the legacy client.
const store = configureStore({
  reducer: {
    authReducer,
    notificationReducer,
  },
});

export default store;

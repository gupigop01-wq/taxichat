import { createSlice } from "@reduxjs/toolkit";

const initialState = [];

// Monotonic id: two notices added in the same millisecond still differ, so
// list keys stay unique and every notice is rendered (and voiced).
let nextId = 1;

const notificationSlice = createSlice({
  name: "notification",
  initialState,
  reducers: {
    // Only one notice is on screen at a time: a new one replaces the previous
    // instead of stacking a list of stale cards.
    addNotification: (state, { payload }) => {
      const id = nextId++;
      return [{ ...payload, id }];
    },
    removeNotification: (state, { payload: id }) => {
      return state.filter((notif) => notif.id !== id);
    },
    // Offer cards of an order are stale once it leaves PUBLISHED (accepted
    // elsewhere, cancelled, expired): drop them so "Принять" cannot be tapped
    removeOfferNotices: (state, { payload: orderId }) =>
      state.filter((notif) => !notif.offer || String(notif.offer.orderId) !== String(orderId)),
    clearAllNotifications: () => initialState,
  },
});

export const notificationActions = notificationSlice.actions;

export default notificationSlice.reducer;

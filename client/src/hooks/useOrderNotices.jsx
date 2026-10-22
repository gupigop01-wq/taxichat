import { useEffect, useRef } from "react";
import { useDispatch } from "react-redux";
import { notificationActions } from "../store/notificationSlice";
import useSocket from "./useSocket";
import { orderStatusNotice, newOrderNotice, newOfferNotice, newMessageNotice } from "../taxi/orderNotices";

// Live notices for the current role only:
//  - driver/dispatcher: new orders in the city
//  - passenger: offers and status of own orders
//  - participant (passenger or assigned driver): status of own order
// Personal and order-room status copies share scope "order" and an eventId.
// The city copy only refreshes lists; participants get one notice on any page.
const useOrderNotices = ({ role, userId }) => {
  const dispatch = useDispatch();
  const { socket } = useSocket();
  const roleRef = useRef(role);
  const userRef = useRef(userId);
  const shownKeys = useRef(new Set());
  roleRef.current = role;
  userRef.current = userId;

  useEffect(() => {
    const show = (notice) => dispatch(notificationActions.addNotification(notice));
    // Bound the cache without forgetting the event that was just received.
    const showOnce = (key, notice) => {
      const signed = `${userRef.current ?? ""}:${key}`;
      if (shownKeys.current.has(signed)) return;
      shownKeys.current.add(signed);
      if (shownKeys.current.size > 200) {
        shownKeys.current.delete(shownKeys.current.values().next().value);
      }
      show(notice);
    };

    const onNew = () => {
      if (["driver", "dispatcher", "region_admin"].includes(roleRef.current)) show(newOrderNotice());
    };
    const onOffer = (payload) => {
      if (roleRef.current === "passenger") showOnce(`offer:${payload?.orderId}:${payload?.offerId}`, newOfferNotice(payload));
    };
    const onStatus = (payload) => {
      if (payload?.orderId && payload?.status && payload.status !== "PUBLISHED") {
        dispatch(notificationActions.removeOfferNotices(payload.orderId));
      }
      if (payload?.scope !== "order") return;
      const me = String(userRef.current ?? "");
      if (!me) return;
      const isParticipant =
        String(payload?.passengerId) === me || String(payload?.driverId) === me;
      // The status fallback covers events from the server before eventId ships.
      if (isParticipant) showOnce(`status:${payload?.orderId}:${payload?.eventId ?? payload?.status}`, orderStatusNotice(payload));
    };

    const onMessage = (payload) => {
      // Own messages never produce a notice
      if (String(payload?.senderId) === String(userRef.current ?? "")) return;
      // A mounted chat in a hidden tab is not being read.
      const openOrderId = window.__bombilaOpenOrderId;
      if (document.visibilityState === "visible" && payload?.orderId && openOrderId != null &&
          String(payload.orderId) === String(openOrderId)) return;
      show(newMessageNotice(payload));
    };

    socket.on("order:new", onNew);
    socket.on("order:message", onMessage);
    socket.on("order:offer", onOffer);
    socket.on("order:status", onStatus);
    return () => {
      socket.off("order:new", onNew);
      socket.off("order:message", onMessage);
      socket.off("order:offer", onOffer);
      socket.off("order:status", onStatus);
    };
  }, [dispatch, socket]);
};

export default useOrderNotices;

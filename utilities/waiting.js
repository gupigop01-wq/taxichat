// Paid waiting: the free window starts when the driver presses "Я на месте",
// every started minute beyond it costs the city rate. The terms are copied onto
// the order at that moment, so a later settings change never rewrites an order
// that is already waiting. The view is computed on read: while waiting it
// ticks, after the ride it stays frozen at the moment waiting ended.
const MINUTE_MS = 60 * 1000;

const waitingView = (waiting, now = Date.now()) => {
  if (!waiting?.startedAt) return null;

  const startedAt = new Date(waiting.startedAt);
  const freeMinutes = Math.max(0, Number(waiting.freeMinutes) || 0);
  const pricePerMin = Math.max(0, Number(waiting.pricePerMin) || 0);
  const freeEndsAt = new Date(startedAt.getTime() + freeMinutes * MINUTE_MS);
  const endedAt = waiting.endedAt ? new Date(waiting.endedAt) : null;
  const endMs = Math.max(startedAt.getTime(), endedAt ? endedAt.getTime() : now);
  const paidMs = Math.max(0, endMs - freeEndsAt.getTime());
  // A started paid minute is charged in full, like a taxi meter
  const paidMinutes = Math.ceil(paidMs / MINUTE_MS);

  return {
    startedAt,
    freeMinutes,
    freeEndsAt,
    pricePerMin,
    endedAt,
    waitedMinutes: Math.ceil(Math.max(0, endMs - startedAt.getTime()) / MINUTE_MS),
    paidMinutes,
    fee: paidMinutes * pricePerMin,
  };
};

const waitingFeeText = (view) =>
  view && view.fee > 0
    ? `Платное ожидание: ${view.paidMinutes} мин × ${view.pricePerMin} ₽ = ${view.fee} ₽`
    : null;

module.exports = { MINUTE_MS, waitingView, waitingFeeText };

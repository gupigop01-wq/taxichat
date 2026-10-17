import { useEffect, useState } from "react";
import { apiGet } from "./api";
import useSocket from "../hooks/useSocket";
import { statusBadge, formatWhen } from "./statusLabels";

// "Поездки": the journal of the user's orders in the chosen city. Tapping a
// trip opens its order chat (driver and passenger share the same screen).
const ACTIVE = ["PUBLISHED", "BOOKED", "ASSIGNED", "ARRIVING", "WAITING", "IN_RIDE", "DISPUTE"];

const TripsList = ({ cityId, me, onOpen }) => {
  const [trips, setTrips] = useState([]);
  const [filter, setFilter] = useState("active");
  const [error, setError] = useState(null);

  const { socketListen, socket } = useSocket();
  const load = () => {
    if (!cityId) return;
    apiGet(`/api/orders?cityId=${cityId}`)
      .then((res) => setTrips(res.data.orders))
      .catch((err) => setError(err.message));
  };

  // Live journal: refresh on any order change in the city or for own trips
  useEffect(() => {
    load();
    socketListen("order:new", load);
    socketListen("order:status", load);
    socketListen("order:offer", load);
    socketListen("order:offersChanged", load);
    return () => {
      socket.off("order:new", load);
      socket.off("order:status", load);
      socket.off("order:offer", load);
      socket.off("order:offersChanged", load);
    };
  }, [cityId]);

  const userId = String(me?.user?._id ?? "");
  const mine = trips.filter(
    (trip) => String(trip.passengerId) === userId || String(trip.driverId) === userId
  );
  const shown = mine.filter((trip) =>
    filter === "active" ? ACTIVE.includes(trip.status) : !ACTIVE.includes(trip.status)
  );

  return (
    <div className="p-3 space-y-3 overflow-y-auto h-full max-w-[42rem] mx-auto w-full">
      <div className="flex justify-center gap-2">
        {[
          ["active", "🟢 Текущие"],
          ["done", "🏁 Прошлые"],
        ].map(([key, label]) => (
          <button
            key={key}
            onClick={() => setFilter(key)}
            className={`press px-3 py-1.5 rounded-xl text-[1.3rem] ${
              filter === key ? "btn-accent font-bold" : "glass text-secondary-text"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {error && <div className="text-danger text-sm text-center">{error}</div>}

      {shown.length === 0 && (
        <div className="text-center text-[1.3rem] text-secondary-text py-6">
          {filter === "active" ? "🛋 Текущих поездок нет" : "🗂 Прошлых поездок пока нет"}
        </div>
      )}

      {shown.map((trip) => {
        const asDriver = String(trip.driverId) === userId;
        return (
          <button
            key={trip._id}
            onClick={() => onOpen(trip._id)}
            className="press anim-rise w-full text-left glass rounded-2xl p-3 space-y-1"
          >
            <div className="flex items-center justify-between gap-2 text-[1.2rem] text-secondary-text">
              <span>{asDriver ? "🚕 Вы — водитель" : "🧍 Вы — пассажир"}</span>
              <span>{formatWhen(trip.when)}</span>
            </div>
            <div className="font-semibold text-[1.4rem] break-words">
              📍 {trip.to?.text ? `${trip.from?.text} → ${trip.to.text}` : trip.from?.text}
            </div>
            <div className="text-[1.2rem]">{statusBadge(trip.status)}</div>
          </button>
        );
      })}
    </div>
  );
};

export default TripsList;

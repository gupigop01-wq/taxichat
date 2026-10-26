import { useCallback, useEffect, useState } from "react";
import { apiGet } from "./api";
import useSocket from "../hooks/useSocket";
import { statusBadge, formatWhen } from "./statusLabels";
import { IconText } from "./TaxiIcon";

// "Поездки": the journal of the user's orders in the chosen city. Tapping a
// trip opens its order chat (driver and passenger share the same screen).
const ACTIVE = ["PUBLISHED", "BOOKED", "ASSIGNED", "ARRIVING", "WAITING", "IN_RIDE", "DISPUTE"];

const TripsList = ({ cityId, cityTz, me, onOpen }) => {
  const [trips, setTrips] = useState([]);
  const [filter, setFilter] = useState("active");
  const [error, setError] = useState(null);

  const { socket } = useSocket();
  const load = useCallback(() => {
    if (!cityId) return;
    apiGet(`/api/orders?cityId=${cityId}`)
      .then((res) => setTrips(res.data.orders))
      .catch((err) => setError(err.message));
  }, [cityId]);

  // Live journal: refresh on any order change in the city or for own trips
  useEffect(() => {
    load();
    socket.on("order:new", load);
    socket.on("order:status", load);
    socket.on("order:offer", load);
    socket.on("order:offersChanged", load);
    return () => {
      socket.off("order:new", load);
      socket.off("order:status", load);
      socket.off("order:offer", load);
      socket.off("order:offersChanged", load);
    };
  }, [cityId, load, socket]);

  const userId = String(me?.user?._id ?? "");
  const mine = trips.filter(
    (trip) => String(trip.passengerId) === userId || String(trip.driverId) === userId
  );
  const shown = mine.filter((trip) =>
    filter === "active" ? ACTIVE.includes(trip.status) : !ACTIVE.includes(trip.status)
  );

  return (
    <div className="p-3 space-y-3 overflow-y-auto h-full max-w-[48rem] mx-auto w-full">
      <div className="taxi-filter-row flex justify-center gap-2">
        {[
          ["active", "🟢 Текущие"],
          ["done", "🏁 Прошлые"],
        ].map(([key, label]) => (
          <button
            key={key}
            onClick={() => setFilter(key)}
            aria-pressed={filter === key}
             className={`press taxi-filter-tab text-[1.3rem] ${
               filter === key ? "is-active" : ""
             }`}
          >
             <IconText>{label}</IconText>
          </button>
        ))}
      </div>

      {error && <div className="text-danger text-sm text-center">{error}</div>}

      {shown.length === 0 && (
         <div className="taxi-empty-state text-center text-[1.3rem] text-secondary-text py-8">
           <IconText>{filter === "active" ? "🛋 Текущих поездок нет" : "🗂 Прошлых поездок пока нет"}</IconText>
        </div>
      )}

      {shown.map((trip) => {
        const asDriver = String(trip.driverId) === userId;
        const peerName = asDriver ? trip.passenger?.name : trip.driver?.displayName;
        return (
          <button
            key={trip._id}
            onClick={() => onOpen(trip._id)}
             className="press taxi-trip-card w-full text-left p-4 space-y-2"
          >
            <div className="flex items-center justify-between gap-2 text-[1.2rem] text-secondary-text">
               <span><IconText>{asDriver ? "🚕 Вы — водитель" : "🧍 Вы — пассажир"}</IconText></span>
               <span><IconText>{formatWhen(trip.when, cityTz)}</IconText></span>
            </div>
            {peerName && (
              <div className="text-[1.3rem] text-primary-text">
                <IconText>{asDriver ? "🧍" : "🚕"}</IconText> {peerName}
              </div>
            )}
            <div className="font-semibold text-[1.4rem] break-words">
               <IconText>📍</IconText> {trip.to?.text ? `${trip.from?.text} → ${trip.to.text}` : trip.from?.text}
            </div>
             <div className="text-[1.2rem]"><IconText>{statusBadge(trip.status)}</IconText></div>
          </button>
        );
      })}
    </div>
  );
};

export default TripsList;

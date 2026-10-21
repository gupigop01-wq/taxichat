import { useEffect, useRef, useState } from "react";
import { apiGet, apiPost, apiPatch, apiDelete } from "./api";
import useSocket, { reconnectSocket } from "../hooks/useSocket";

const LAST_CITY_KEY = "bombila.lastCityId";
const LAST_ROLE_PREFIX = "bombila.lastRole.";

// Main city of the project: used as the default before the first manual pick
const DEFAULT_CITY_NAME = "Слюдянка";

// Initial city: the home city chosen at registration (user.homeCityId),
// then the last city picked manually, then the main city (Слюдянка), and only
// then the first city of the list.
const pickInitialCity = (cities, homeCityId) => {
  const has = (id) => id && cities.some((c) => String(c._id) === String(id));
  if (has(homeCityId)) return String(homeCityId);
  const last = localStorage.getItem(LAST_CITY_KEY);
  if (has(last)) return String(last);
  const main = cities.find((c) => c.name === DEFAULT_CITY_NAME);
  if (main) return String(main._id);
  return cities[0]?._id ? String(cities[0]._id) : null;
};

// Core state of the taxi workspace: the user, his memberships, the selected
// city and role, zones of the city and live presence
const useTaxi = () => {
  const { socketEmit, socketListen, socket } = useSocket();
  const [me, setMe] = useState(null);
  const [cities, setCities] = useState([]);
  const [cityId, setCityIdState] = useState(null);
  const [role, setRole] = useState(null);
  const [error, setError] = useState(null);

  // Remember the city the user picked manually
  const setCityId = (id) => {
    if (id) localStorage.setItem(LAST_CITY_KEY, String(id));
    setCityIdState(id);
  };

  const refreshMe = async () => {
    const res = await apiGet("/api/user/me");
    setMe(res.data);
    return res.data;
  };

  useEffect(() => {
    refreshMe()
      .then((data) => {
        if (data.user._id) {
          // The socket may have connected before the cookie was available
          // (anonymous handshake). Reconnect so the server binds the user and
          // joins the membership rooms, then announce online.
          reconnectSocket();
          socketEmit("user:online", data.user._id);
        }
      })
      .catch((err) => setError(err.message));

    apiGet("/api/geo/cities")
      .then((res) => setCities(res.data.cities))
      .catch((err) => setError(err.message));

    // Roles change live: driver application review, waitlist activation
    const onMembershipUpdated = () => refreshMe();
    socketListen("membership:updated", onMembershipUpdated);
    return () => {
      socket.off("membership:updated", onMembershipUpdated);
    };
  }, []);

  // Initial city once both the city list and the user are loaded:
  // home city (chosen at registration) -> last manual pick -> first city
  const memberships = me?.memberships ?? [];
  const autoPicked = useRef(false);
  useEffect(() => {
    if (autoPicked.current || !cities.length || !me) return;
    autoPicked.current = true;
    setCityIdState(pickInitialCity(cities, me.user?.homeCityId));
  }, [cities, me]);

  // Auto-select the role for the chosen city. A manually chosen role is kept
  // across membership updates while it stays active in the city; the server
  // priority (driver > dispatcher > region_admin) applies only on first entry.
  const cityMembership = (r) =>
    memberships.find(
      (m) =>
        m.role === r && m.status === "ACTIVE" && String(m.cityId?._id) === String(cityId)
    );

  useEffect(() => {
    if (!cityId) return;
    const saved = localStorage.getItem(LAST_ROLE_PREFIX + cityId);
    if (saved && cityMembership(saved)) {
      setRole(saved);
      return;
    }
    const nextRole =
      ["driver", "dispatcher", "region_admin"].find((r) => cityMembership(r)) ?? "passenger";
    setRole(nextRole);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cityId, memberships.length]);

  const selectRole = (r) => {
    if (cityId) localStorage.setItem(LAST_ROLE_PREFIX + cityId, String(r));
    setRole(r);
  };

  const userRole =
    cityMembership(role) || (me?.user?.isSuperadmin && role === "dispatcher")
      ? role
      : "passenger";

  return {
    me,
    refreshMe,
    user: me?.user,
    memberships,
    cities,
    cityId,
    setCityId,
    role: userRole,
    setRole: selectRole,
    membership: cityMembership(userRole),
    driverProfile:
      me?.driverProfiles?.find(
        (profile) =>
          String(profile.membershipId) === String(cityMembership("driver")?._id)
      ) ?? null,
    error,
  };
};

export default useTaxi;

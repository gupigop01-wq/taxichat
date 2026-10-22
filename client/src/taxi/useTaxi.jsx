import { useCallback, useEffect, useRef, useState } from "react";
import { apiGet } from "./api";
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
  const { socket } = useSocket();
  const [me, setMe] = useState(null);
  const [cities, setCities] = useState([]);
  const [cityId, setCityIdState] = useState(null);
  const [role, setRole] = useState(null);
  const [error, setError] = useState(null);
  const requestsRef = useRef(null);

  // Remember the city the user picked manually
  const setCityId = (id) => {
    if (id) localStorage.setItem(LAST_CITY_KEY, String(id));
    setCityIdState(id);
  };

  const refreshMe = useCallback(async () => {
    const controller = requestsRef.current;
    if (!controller || controller.signal.aborted) {
      throw new DOMException("Request cancelled", "AbortError");
    }
    const res = await apiGet("/api/user/me", { signal: controller.signal });
    if (controller.signal.aborted || requestsRef.current !== controller) {
      throw new DOMException("Request cancelled", "AbortError");
    }
    setMe(res.data);
    return res.data;
  }, []);

  useEffect(() => {
    // A flaky mobile network must not leave the app stuck on "Выберите
    // город": retry the startup requests with a growing delay
    const controller = new AbortController();
    const { signal } = controller;
    requestsRef.current = controller;
    const retryTimers = new Map();
    const waitForRetry = (delay) => new Promise((resolve, reject) => {
      const id = setTimeout(() => {
        retryTimers.delete(id);
        resolve();
      }, delay);
      retryTimers.set(id, reject);
    });
    const withRetry = async (fn) => {
      for (let attempt = 0; ; attempt += 1) {
        if (signal.aborted) throw new DOMException("Request cancelled", "AbortError");
        try {
          return await fn();
        } catch (err) {
          if (signal.aborted || err.name === "AbortError") throw err;
          if (attempt >= 5) {
            setError(err.message);
            throw err;
          }
          await waitForRetry(1000 * 2 ** attempt);
        }
      }
    };

    withRetry(refreshMe)
      .then((data) => {
        if (!signal.aborted && data.user._id) {
          // The socket may have connected before the cookie was available
          // (anonymous handshake). Reconnect so the server binds the user and
          // joins the membership rooms, then announce online.
          reconnectSocket();
          socket.emit("user:online", data.user._id);
        }
      })
      .catch(() => {});

    withRetry(() => apiGet("/api/geo/cities", { signal }))
      .then((res) => {
        if (!signal.aborted) setCities(res.data.cities);
      })
      .catch(() => {});

    // Roles change live: driver application review, waitlist activation
    const onMembershipUpdated = () => refreshMe().catch((err) => {
      if (!signal.aborted && err.name !== "AbortError") setError(err.message);
    });
    socket.on("membership:updated", onMembershipUpdated);
    return () => {
      controller.abort();
      if (requestsRef.current === controller) requestsRef.current = null;
      retryTimers.forEach((reject, id) => {
        clearTimeout(id);
        reject(new DOMException("Request cancelled", "AbortError"));
      });
      retryTimers.clear();
      socket.off("membership:updated", onMembershipUpdated);
    };
  }, [refreshMe, socket]);

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

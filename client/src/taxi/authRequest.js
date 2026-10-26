import { useState } from "react";
// POST helper for the auth screens: returns the parsed body and throws an
// Error carrying the server message (shown in the form banner).
export const postJson = async (url, body) => {
  const res = await fetch(url, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message ?? "Ошибка запроса");
  return data;
};

// Request state of an auth form: "loading" while the call is in flight.
export const useAuthRequest = () => {
  const [state, setState] = useState();
  const run = async (url, body) => {
    setState("loading");
    try {
      const data = await postJson(url, body);
      setState("success");
      return data;
    } catch (error) {
      setState("error");
      throw error;
    }
  };
  return { state, run };
};

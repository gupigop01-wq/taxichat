import { useEffect } from "react";
import { useSelector } from "react-redux";

// Minimal boot hook of the app shell: theme and the authenticated flag.
// Contacts and the legacy contact-call flow were removed with the legacy
// messenger client; the taxi workspace initializes itself in useTaxi.
const useInit = () => {
  // Set app theme
  useEffect(() => {
    const initialMode = JSON.parse(localStorage.getItem("darkMode"));
    document
      .querySelector("html")
      .setAttribute("class", initialMode ? "dark" : "null");
  }, []);

  // Get logged in state
  const loggedIn = useSelector((state) => state.authReducer.loggedIn);

  return {
    loggedIn,
  };
};

export default useInit;

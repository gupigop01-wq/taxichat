import React from "react";
import ReactDOM from "react-dom/client";
import "./index.css";
import App from "./App";
import ShareView from "./taxi/ShareView";
import reportWebVitals from "./reportWebVitals";
import { Provider } from "react-redux";
import appStore from "./store/appStore";
import { registerServiceWorker } from "./taxi/pushClient";

import * as process from "process";

window.global = window;
window.process = process;
window.Buffer = [];

// The service worker is registered before any auth/install gate so the app is
// installable (PWA) and push-ready from the very first visit.
registerServiceWorker();

// Public share links render without the app shell
if (window.location.pathname.startsWith("/share/")) {
  const root = ReactDOM.createRoot(document.getElementById("root"));
  root.render(<ShareView />);
} else {
  const root = ReactDOM.createRoot(document.getElementById("root"));
  root.render(
    <Provider store={appStore}>
      <App />
    </Provider>
  );
}

// If you want to start measuring performance in your app, pass a function
// to log results (for example: reportWebVitals(console.log)). Learn more: https://bit.ly/CRA-vitals
reportWebVitals();

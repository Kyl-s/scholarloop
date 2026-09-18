import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import { DataProvider } from "./store.jsx";
import AppErrorBoundary from "./components/AppErrorBoundary.jsx";
import "./styles.css";

if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch((error) => {
      console.warn("PWA Service Worker 注册失败", error);
    });
  });
}

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <AppErrorBoundary>
      <DataProvider>
        <App />
      </DataProvider>
    </AppErrorBoundary>
  </React.StrictMode>
);

import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import { DataProvider } from "./store.jsx";
import "./styles.css";

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <DataProvider>
      <App />
    </DataProvider>
  </React.StrictMode>
);

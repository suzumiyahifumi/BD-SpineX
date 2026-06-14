import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { bd2Api } from "./tauri-api";
import "./styles.css";

if (!Object.prototype.hasOwnProperty.call(window, "bd2")) {
  window.bd2 = bd2Api;
}

createRoot(document.getElementById("root")!).render(
  <App />
);

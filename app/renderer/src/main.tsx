import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { bd2Api } from "./tauri-api";
import "./styles.css";

type NavigatorWithUserAgentData = Navigator & {
  userAgentData?: {
    brands?: Array<{ brand: string; version: string }>;
  };
};

type RuntimeWindow = Window & {
  __TAURI_INTERNALS__?: unknown;
  process?: {
    versions?: {
      electron?: string;
    };
  };
};

function detectRuntime() {
  const win = window as RuntimeWindow;

  if (typeof win.__TAURI_INTERNALS__ !== "undefined" || /\bTauri\b/i.test(navigator.userAgent)) {
    return "tauri";
  }

  if (win.process?.versions?.electron || /\bElectron\//.test(navigator.userAgent)) {
    return "electron";
  }

  return "web";
}

function isChromiumFamilyBrowser() {
  const ua = navigator.userAgent;
  const nav = navigator as NavigatorWithUserAgentData;
  const brands = nav.userAgentData?.brands?.map((item) => item.brand.toLowerCase()) ?? [];
  const hasChromiumBrand = brands.some((brand) =>
    brand.includes("chromium") ||
    brand.includes("google chrome") ||
    brand.includes("microsoft edge") ||
    brand.includes("opera")
  );
  const isIOSWebKit =
    /\b(iPad|iPhone|iPod)\b/.test(ua) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

  return !isIOSWebKit && (hasChromiumBrand || /\b(?:Chrome|Chromium|Edg|OPR|SamsungBrowser|Electron)\//.test(ua));
}

function supportsLiquidGlassFilter() {
  if (typeof CSS === "undefined" || typeof CSS.supports !== "function") {
    return false;
  }

  return (
    CSS.supports("backdrop-filter", "blur(1px) url(#liquid-lens)") ||
    CSS.supports("-webkit-backdrop-filter", "blur(1px) url(#liquid-lens)")
  );
}

function configureGlassMode() {
  document.documentElement.setAttribute(
    "data-glass",
    isChromiumFamilyBrowser() && supportsLiquidGlassFilter() ? "liquid" : "frosted"
  );
}

function configureRuntimeMode() {
  document.documentElement.setAttribute("data-runtime", detectRuntime());
}

configureRuntimeMode();
configureGlassMode();

if (!Object.prototype.hasOwnProperty.call(window, "bd2")) {
  window.bd2 = bd2Api;
}

createRoot(document.getElementById("root")!).render(
  <App />
);

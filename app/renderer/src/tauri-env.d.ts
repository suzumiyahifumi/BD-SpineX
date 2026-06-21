import type { Bd2Api } from "./tauri-api";

declare global {
  interface Window {
    bd2: Bd2Api;
  }
}

export {};

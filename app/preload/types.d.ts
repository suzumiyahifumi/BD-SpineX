import type { Bd2Api } from "./index.cjs";

declare global {
  interface Window {
    bd2: Bd2Api;
  }
}

export {};

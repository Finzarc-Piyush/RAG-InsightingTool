const getWindowOrigin = () => {
  if (typeof window === "undefined") {
    return "https://marico-insight-safe.vercel.app";
  }
  return window.location.origin;
};

/**
 * Dev default is same-origin (empty base) so requests hit `/api/*` and Vite proxies to the API
 * (see vite.config.ts). That avoids browser CORS + credentials issues. Override with VITE_API_URL
 * when the UI must call a remote API directly.
 */
export const API_BASE_URL =
  import.meta.env.VITE_API_URL ||
  (import.meta.env.PROD ? getWindowOrigin() : "");



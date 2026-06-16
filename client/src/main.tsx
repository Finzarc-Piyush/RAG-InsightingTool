import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";
import { reportClientError } from "./lib/errorSink";

// OBS-6 · Global last-resort error sink. The ErrorBoundary only catches errors
// thrown during React render; these two window listeners catch everything else
// (event handlers, async callbacks, rejected promises) and forward them to the
// server error sink. Both are best-effort and fire-and-forget — reportClientError
// throttles/caps and never throws, so a storm can't loop a handler. Console
// logging by the browser stays intact (we don't preventDefault).
if (typeof window !== "undefined") {
  window.addEventListener("error", (event: ErrorEvent) => {
    const err = event.error;
    void reportClientError({
      message:
        (err && (err.message as string)) || event.message || "Uncaught error",
      stack: err && err.stack ? err.stack : undefined,
      source: "window.onerror",
    });
  });

  window.addEventListener(
    "unhandledrejection",
    (event: PromiseRejectionEvent) => {
      const reason = event.reason as { message?: string; stack?: string } | undefined;
      void reportClientError({
        message:
          (reason && reason.message) ||
          (typeof event.reason === "string" ? event.reason : "Unhandled promise rejection"),
        stack: reason && reason.stack ? reason.stack : undefined,
        source: "window.onunhandledrejection",
      });
    },
  );
}

// P-071: fail with a clear message instead of a cryptic null-deref crash
// if index.html is ever missing the #root element.
const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("Missing #root element in index.html — cannot mount the app.");
}
createRoot(rootElement).render(<App />);

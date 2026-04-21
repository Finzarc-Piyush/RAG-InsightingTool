import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";

// P-071: fail with a clear message instead of a cryptic null-deref crash
// if index.html is ever missing the #root element.
const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("Missing #root element in index.html — cannot mount the app.");
}
createRoot(rootElement).render(<App />);

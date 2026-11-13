import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { Pair } from "./Pair.js";

/** The kernel serves this bundle at `/`; a pairing link lands on `/pair#<code>`. */
const pairing = location.pathname.replace(/\/+$/, "") === "/pair";

createRoot(document.getElementById("root")!).render(
  <StrictMode>{pairing ? <Pair /> : <App />}</StrictMode>,
);

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { Portal } from "./Portal";
import "./tokens.css";
import "./app.css";

createRoot(document.getElementById("root")!).render(<StrictMode>{location.pathname.startsWith("/portal") ? <Portal /> : <App />}</StrictMode>);

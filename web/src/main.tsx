import React from "react";
import ReactDOM from "react-dom/client";
import "@fontsource-variable/ibm-plex-sans";
import "@fontsource-variable/jetbrains-mono";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/shell.css";
import "./styles/controls.css";
import "./styles/policy.css";
import "./styles/work.css";
import "./styles/evidence.css";
import App from "./App";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

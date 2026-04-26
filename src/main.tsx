import React from "react";
import ReactDOM from "react-dom/client";
import { getCurrentWindow } from "@tauri-apps/api/window";
import ControlWindow from "@/windows/ControlWindow";
import TranslationWindow from "@/windows/TranslationWindow";
import "./App.css";

const label = getCurrentWindow().label;

function pickRoot() {
  if (label === "en") return <TranslationWindow lang="en" />;
  if (label === "vi") return <TranslationWindow lang="vi" />;
  return <ControlWindow />;
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>{pickRoot()}</React.StrictMode>,
);

import React from "react";
import ReactDOM from "react-dom/client";
import { getCurrentWindow } from "@tauri-apps/api/window";
import ControlWindow from "@/windows/ControlWindow";
import TranslationWindow from "@/windows/TranslationWindow";
import "./App.css";

const label = getCurrentWindow().label;

function pickRoot() {
  // t1 / t2 are the two configurable translation slots; the language each
  // shows is resolved from config at runtime, not baked into the label.
  if (label === "t1") return <TranslationWindow slotIndex={0} />;
  if (label === "t2") return <TranslationWindow slotIndex={1} />;
  return <ControlWindow />;
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>{pickRoot()}</React.StrictMode>,
);

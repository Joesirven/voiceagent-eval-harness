import "../app.css";
import "../brand.css";
import { createRoot } from "react-dom/client";
import { FlowPanel } from "./FlowPanel";

// Previews the Flow panel alone on the dev server, at /flow-preview.html. The console does not load this file.
createRoot(document.getElementById("root")!).render(
  <div style={{ padding: 16, maxWidth: 1400, margin: "0 auto" }}>
    <FlowPanel />
  </div>,
);

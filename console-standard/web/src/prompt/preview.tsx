import "@pipecat-ai/voice-ui-kit/styles.css";
import "../app.css";
import "../brand.css";
import { createRoot } from "react-dom/client";
import { installFake } from "./fake";
import { PromptPanel } from "./PromptPanel";

if (new URLSearchParams(location.search).has("fake")) installFake();
createRoot(document.getElementById("root")!).render(<div style={{ padding: 16, maxWidth: 1100, boxSizing: "border-box" }}><PromptPanel /></div>);

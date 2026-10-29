/** The picker: one design at a time, chosen by number, kept in the URL (?design=3) for sharing. */
import { useEffect, useState } from "react";
import { TREE } from "../../lab/src/tree-data.js";
import { DESIGNS } from "./registry.js";

function initialIndex(): number {
  const n = Number(new URLSearchParams(location.search).get("design"));
  return Number.isInteger(n) && n >= 1 && n <= DESIGNS.length ? n - 1 : 0;
}

export function App() {
  const [index, setIndex] = useState(initialIndex);
  useEffect(() => {
    const url = new URL(location.href);
    url.searchParams.set("design", String(index + 1));
    history.replaceState(null, "", url);
  }, [index]);
  const { Component, name, idea } = DESIGNS[index];
  return (
    <div>
      <nav style={{ display: "flex", flexWrap: "wrap", gap: 6, padding: "12px 16px", borderBottom: "1px solid #ddd8cc", background: "#fff" }}>
        {DESIGNS.map((d, i) => (
          <button
            key={d.name}
            onClick={() => setIndex(i)}
            aria-current={i === index ? "page" : undefined}
            style={{ padding: "6px 10px", borderRadius: 6, border: "1px solid #cfc9bb", background: i === index ? "#1f2a37" : "#fff", color: i === index ? "#fff" : "#1f2a37", cursor: "pointer" }}
          >
            {i + 1}. {d.name}
          </button>
        ))}
      </nav>
      <p style={{ margin: "12px 16px", color: "#5b6472" }}>{idea}</p>
      <main>
        <Component tree={TREE} />
      </main>
    </div>
  );
}

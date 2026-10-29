/** Development only: an in-page stand-in for the prompt routes, used when the preview page is opened with ?fake=1. */
export function installFake() {
  const layers = [{ id: "floor", title: "Safety floor", editable: false }, { id: "role", title: "Role", editable: true }, { id: "style", title: "Speaking style", editable: true }, { id: "disclosure", title: "Disclosure", editable: false }];
  const setups: any[] = [
    { id: "harness-default", label: "Harness default", description: "The prompt the harness ships with.", shipped: true, layers: ["floor", "role", "style", "disclosure"], personalityId: "warm", overrides: {} },
    { id: "short-calls", label: "Short calls", description: "Custom: fewer words.", shipped: false, layers: ["floor", "role", "disclosure"], personalityId: "brisk", overrides: { role: "You help callers get a quote quickly." } },
  ];
  let selectedId = "harness-default";
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
  const real = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = String(input), m = init?.method ?? "GET";
    if (!url.startsWith("/api/")) return real(input, init);
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (url === "/api/prompt-setups") return json({ setups, selectedId, layers, personalities: [{ id: "warm", label: "Warm" }, { id: "brisk", label: "Brisk" }], disclosure: { text: "Hello, this is an automated assistant calling for Northwind Insurance Agency. This call may be recorded.", locked: true, note: "Required opening script." } });
    if (url.includes("/sections")) {
      const id = url.split("/")[3]; const s = setups.find((x) => x.id === id);
      const defs: any = { floor: "Never give legal advice. Hand over to a person when asked.", role: "You are a helpful insurance assistant for [agency name].", style: "Speak in short sentences." };
      return json({ sections: s.layers.filter((l: string) => l !== "disclosure").map((l: string) => ({ id: l, title: layers.find((x) => x.id === l)!.title, editable: l !== "floor", text: s.overrides[l] ?? defs[l], defaultText: defs[l], overridden: l in s.overrides })) });
    }
    if (url.endsWith("/preview")) { const t = Object.values<string>(body.setup.overrides).join("\n\n") + "\n\nHello, this is an automated assistant calling for Northwind Insurance Agency.\n\nLead context\nName: Maria Lopez (" + body.lead + ")"; return json({ text: t, approxTokens: Math.ceil(t.length / 4) }); }
    if (url.endsWith("/select")) { selectedId = url.split("/")[3]; return json({ selectedId }); }
    const id = url.split("/")[3];
    if (m === "PUT") { const i = setups.findIndex((x) => x.id === id); if (i >= 0 && setups[i].shipped) return json({ error: "setup_is_shipped" }, 409); const s = { id, shipped: false, ...body }; if (i >= 0) setups[i] = s; else setups.push(s); return json(s); }
    if (m === "DELETE") { const i = setups.findIndex((x) => x.id === id); if (setups[i]?.shipped) return json({ error: "setup_is_shipped" }, 409); setups.splice(i, 1); return json({ ok: true }); }
    return json({ error: "setup_unknown" }, 404);
  };
}

/**
 * The harness interface mock: a scripted call that plays forward on a timer,
 * can be paused and scrubbed, and renders with textContent only. No network,
 * no real calls. Events are grouped by the same `align` the control page uses.
 */
import * as core from "/live-view-core.js";
import { leads, voiceModules, decisionModules, promptSetups, tree, script, summary } from "/mock/mock-data.js";

const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...kids) => {
  const n = Object.assign(document.createElement(tag), props);
  for (const k of kids) n.append(k);
  return n;
};
const TOTAL_MS = script[script.length - 1].ms;
const clockText = (ms) => `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, "0")}`;
const secs = (ms) => `${(ms / 1000).toFixed(1)}s`;

// ---- Setup ----
const state = { lead: leads[0], nowMs: 0, started: false, playing: false, hungUp: false, lastTick: 0, speed: 4, raf: 0 };

function fillSelect(select, options, value) {
  select.replaceChildren(...options.map((o) => el("option", { value: typeof o === "string" ? o : o.value, textContent: typeof o === "string" ? o : o.label })));
  if (value !== undefined) select.value = value;
}
fillSelect($("lead"), leads.map((l) => ({ value: l.id, label: `${l.name}, ${l.business}` })));
fillSelect($("voice"), voiceModules, "Vapi");
fillSelect($("decision"), decisionModules, decisionModules[0]);
fillSelect($("prompt"), promptSetups, promptSetups[0]);

/** Fills braces from the lead and the chosen setup. */
function fill(text) {
  const vars = { ...state.lead, decisionModule: $("decision").value.replace(" (default)", "") };
  return String(text).replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
}
function filled(value) {
  if (typeof value === "string") return fill(value);
  if (Array.isArray(value)) return value.map(filled);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, filled(v)]));
  return value;
}

function renderSetup() {
  const l = state.lead;
  $("leadMeta").textContent = `${l.trade} · ${l.city} · renews ${l.xDate} · last contact ${l.lastContact}`;
  $("attemptMeta").textContent = $("direction").value === "inbound"
    ? `${l.outboundAttempts} outbound attempts rang out, no message left. This is the lead calling back.`
    : `Attempt ${l.outboundAttempts + 1} would exceed the limit of 2 unanswered attempts. The mock plays the inbound callback instead.`;
  $("contextHint").textContent = `${l.name}, ${l.trade}, ${l.consents.length} consents on file, ${Object.keys(l.quoteFieldsOnFile).length} quote fields on file`;
  const body = $("contextBody");
  const item = (k, v, cls = "") => el("div", { className: cls }, el("div", { className: "k", textContent: k }), el("div", { className: "v", textContent: v }));
  body.replaceChildren(
    item("Lead", `${l.name}, ${l.business}`),
    item("Entity and trade", `${l.entity}; ${l.trade}`),
    item("Phone on file (never dialled in test mode)", l.phone),
    item("Workers' comp renews (X-date)", `${l.xDate}, ${l.xDateWords}`),
    item("Last contact", l.lastContact),
    item("Consents", l.consents.join(" · ")),
    item("Prior call summary", l.priorCallSummary, "wide note"),
    item("Quote fields already on file", Object.keys(l.quoteFieldsOnFile).length
      ? Object.entries(l.quoteFieldsOnFile).map(([k, v]) => `${k} = ${v.value} (“${v.evidence}”)`).join("; ")
      : "none", "wide"),
    item("Prompt setup", `${$("prompt").value}; voice ${$("voice").value}; decisions by ${$("decision").value}`, "wide"),
  );
}

// ---- Playback ----
function setTransport() {
  $("start").disabled = state.started && !state.hungUp;
  $("hangup").disabled = !state.started || state.hungUp || state.nowMs >= TOTAL_MS;
  $("playPause").disabled = !state.started || state.hungUp || state.nowMs >= TOTAL_MS;
  $("playPause").textContent = state.playing || !state.started || state.nowMs >= TOTAL_MS ? "Pause" : "Resume";
  $("scrub").disabled = !state.started;
  $("scrub").value = String(state.nowMs);
  $("clock").textContent = clockText(state.nowMs);
  $("total").textContent = clockText(TOTAL_MS);
  const note = $("transportNote");
  if (!state.started) note.textContent = "Start role-play to play the scripted conversation.";
  else if (state.hungUp) note.textContent = "Ended by the tester. Start role-play to play again.";
  else if (state.nowMs >= TOTAL_MS) note.textContent = "Call over. Drag the slider to look back at any moment.";
  else note.textContent = state.playing ? "Playing the scripted call." : "Paused. Drag the slider or press Resume.";
}

function tick(t) {
  if (!state.playing) return;
  const dt = (t - state.lastTick) * state.speed;
  state.lastTick = t;
  state.nowMs = Math.min(TOTAL_MS, state.nowMs + dt);
  render();
  if (state.nowMs >= TOTAL_MS) state.playing = false;
  else state.raf = requestAnimationFrame(tick);
}
function play() {
  if (state.playing) return;
  state.playing = true;
  state.lastTick = performance.now();
  state.raf = requestAnimationFrame(tick);
}
function pause() {
  state.playing = false;
  cancelAnimationFrame(state.raf);
  render();
}

$("start").onclick = () => {
  state.started = true;
  state.hungUp = false;
  state.nowMs = 0;
  play();
};
$("hangup").onclick = () => {
  state.hungUp = true;
  pause();
};
$("playPause").onclick = () => (state.playing ? pause() : play());
$("scrub").oninput = (e) => {
  state.nowMs = Number(e.target.value);
  if (state.playing) pause(); else render();
};
$("speed").onchange = (e) => { state.speed = Number(e.target.value); };
for (const id of ["lead", "voice", "decision", "prompt", "direction"]) {
  $(id).onchange = () => {
    state.lead = leads.find((l) => l.id === $("lead").value) ?? leads[0];
    renderSetup();
    render();
  };
}

// ---- Events up to now ----
/** Script events that have happened by `nowMs`, in the live trace's shape, plus a hang-up outcome when the tester hung up. */
function eventsNow() {
  const out = [];
  let seq = 0;
  for (const e of script) {
    if (e.ms > state.nowMs) break;
    seq += 1;
    out.push({ seq, recordSeq: seq, recordId: "mock", callId: "mock", type: e.type, atMs: e.ms, at: new Date(e.ms).toISOString(), data: filled(e.data), speakMs: e.speakMs ?? 0 });
  }
  if (state.hungUp && state.nowMs < TOTAL_MS) {
    seq += 1;
    out.push({ seq, recordSeq: seq, recordId: "mock", callId: "mock", type: "call_outcome", atMs: state.nowMs, at: new Date(state.nowMs).toISOString(), data: { status: "abandoned", reason: "hung up by the tester" } });
  }
  return core.eventsFor(out, "mock");
}

/** The words of a line that have arrived by now: a live transcript grows as the speaker talks. */
function spokenSoFar(e) {
  const text = e.data.text;
  if (!e.speakMs || state.nowMs >= e.ms + e.speakMs) return { text, partial: false };
  const words = text.split(" ");
  const n = Math.max(1, Math.floor(words.length * (state.nowMs - e.ms) / e.speakMs));
  return { text: words.slice(0, n).join(" "), partial: true };
}

// ---- Trace rows ----
function traceRow(e) {
  const d = e.data;
  let cls = "", mark = "", label = [], reason = "";
  switch (e.type) {
    case "compliance_check":
      if (d.skipped) { const checks = d.checks ?? [d.check]; cls = "skip"; mark = "–"; label = [checks.length > 1 ? `${checks.length} checks ` : "check ", el("b", { textContent: checks.join(", ") }), " skipped"]; reason = d.reason; }
      else if (d.passed) { cls = "ok"; mark = "✓"; label = ["check ", el("b", { textContent: d.check }), " passed"]; reason = d.reason; }
      else { cls = "bad"; mark = "✗"; label = ["check ", el("b", { textContent: d.check }), " blocked"]; reason = d.reason; }
      break;
    case "tool_call":
      cls = d.success ? "ok" : "bad"; mark = d.success ? "✓" : "✗";
      label = ["tool ", el("b", { textContent: d.tool + (d.target ? ` ${d.target}` : "") }), ` ${d.success ? "ok" : "failed"} ${d.durationMs} ms${d.attempt ? ` (attempt ${d.attempt})` : ""}`];
      reason = d.reason ?? "";
      break;
    case "decision": {
      const low = d.routed === "clarify";
      cls = low ? "decision clarify" : "decision"; mark = low ? "?" : "◆";
      label = ["decided ", el("b", { textContent: d.answer }), ` ${Math.round(d.confidence * 100)}% of ${Math.round(d.minConfidence * 100)}% needed, ${d.module}, ${d.durationMs} ms${low ? ", so: clarify" : ""}`];
      reason = d.reason;
      break;
    }
    case "judge_verdict":
      cls = d.allowed ? "ok" : "bad"; mark = d.allowed ? "✓" : "✗";
      label = ["judge ", el("b", { textContent: `${d.action}${d.target ? ` ${d.target}` : ""}` }), d.allowed ? " allowed" : " blocked"];
      reason = d.reason;
      break;
    case "node_enter": cls = "node"; mark = "→"; label = ["now at ", el("b", { textContent: d.label ?? d.nodeId })]; break;
    case "disposition": cls = "ok"; mark = "■"; label = ["disposition ", el("b", { textContent: tree.dispositions[d.value] ?? d.value })]; break;
    case "call_outcome": cls = d.status === "failed" ? "bad" : "node"; mark = "■"; label = [`call ${d.status}`]; reason = d.reason ?? ""; break;
    case "judge_score": cls = "node"; mark = "■"; label = ["post-call score ", el("b", { textContent: String(d.score) })]; break;
    default: cls = ""; mark = "·"; label = [e.type];
  }
  return el("div", { className: `trow ${cls}` },
    el("span", { className: "ms", textContent: secs(e.ms) }),
    el("span", { className: "mark", textContent: mark }),
    el("span", {}, el("span", { className: "label" }, ...label), reason ? el("span", { className: "reason", textContent: ` · ${reason}` }) : ""));
}

/** Consecutive checks skipped for the same reason become one row, so test mode does not drown the trace. */
function groupSkipped(events) {
  const out = [];
  for (const e of events) {
    const last = out[out.length - 1];
    if (e.type === "compliance_check" && e.data.skipped && last?.type === "compliance_check" && last.data.skipped && last.data.reason === e.data.reason) {
      last.data.checks.push(e.data.check);
    } else if (e.type === "compliance_check" && e.data.skipped) {
      out.push({ ...e, data: { ...e.data, checks: [e.data.check] } });
    } else out.push(e);
  }
  return out;
}

// ---- Record ----
function renderRecord(sorted) {
  const groups = core.align(sorted);
  const rows = $("rows");
  $("recordEmpty").hidden = state.started && groups.length > 0;
  $("traceEmpty").hidden = state.started && groups.length > 0;
  const traceStick = $("traceRows").scrollTop + $("traceRows").clientHeight >= $("traceRows").scrollHeight - 40;
  $("traceRows").replaceChildren();
  if (!state.started) { rows.replaceChildren(); return; }
  const stick = rows.scrollTop + rows.clientHeight >= rows.scrollHeight - 40;
  const lineEvents = new Map(sorted.filter((e) => e.type === "turn").map((e) => [`${e.data.role}:${e.data.turnIndex}`, e]));
  let lastRow = null;
  rows.replaceChildren(...groups.map((g) => {
    const gutter = el("div", { className: "gutter" });
    let speech;
    if (g.line) {
      const e = lineEvents.get(g.line.key);
      const { text, partial } = e ? spokenSoFar(e) : { text: g.line.text, partial: false };
      gutter.append(el("span", { className: `who ${g.line.role}`, textContent: g.line.role === "caller" ? `${state.lead.firstName} (you)` : "agent" }), secs(g.line.ms));
      speech = el("div", { className: `speech ${g.line.role}${partial ? " partial" : ""}`, textContent: text });
    } else {
      gutter.append(el("span", { className: "who", textContent: "call" }), "0.0s");
      speech = el("div", { className: "speech start-marker", textContent: "Line opens. Checks run before a word is said." });
    }
    const trace = el("div", { className: "trace" }, ...groupSkipped(g.rows.map((r) => r.event)).map(traceRow));
    $("traceRows").append(trace);
    const row = el("div", { className: "row" }, gutter, speech);
    lastRow = row;
    return row;
  }));
  if (lastRow && state.nowMs < TOTAL_MS && !state.hungUp) lastRow.classList.add("now");
  if (stick) rows.scrollTop = rows.scrollHeight;
  if (traceStick) $("traceRows").scrollTop = $("traceRows").scrollHeight;
}

// ---- Route panel ----
function renderRoute(sorted) {
  const sum = core.summarize(sorted);
  const dispo = $("disposition");
  dispo.textContent = sum.disposition ? `disposition: ${tree.dispositions[sum.disposition] ?? sum.disposition}` : "no disposition yet";
  dispo.className = `disposition${sum.disposition ? " set" : ""}`;

  // The path: each node entered, with the decision that moved the call on from it.
  const path = $("path");
  const entered = sorted.filter((e) => e.type === "node_enter");
  const decisions = sorted.filter((e) => e.type === "decision");
  path.replaceChildren(...entered.map((n, i) => {
    const next = entered[i + 1];
    const here = i === entered.length - 1;
    const li = el("li", { className: here ? "here" : "" }, n.data.label ?? n.data.nodeId);
    const mine = decisions.filter((d) => d.data.nodeId === n.data.nodeId && d.ms >= n.ms && (!next || d.ms < next.ms));
    for (const d of mine) {
      li.append(el("span", { className: `via${d.data.routed === "clarify" ? " clarify" : ""}`, textContent: d.data.routed === "clarify"
        ? `asked to clarify: ${d.data.answer} at ${Math.round(d.data.confidence * 100)}%, below ${Math.round(d.data.minConfidence * 100)}%`
        : `answered ${d.data.answer} at ${Math.round(d.data.confidence * 100)}%` }));
    }
    return li;
  }));
  if (!entered.length) path.append(el("li", { textContent: state.started ? "Not started yet" : "Press Start role-play" }));

  const latest = $("latest");
  const d = sum.decision;
  if (d) {
    const pct = Math.round(d.confidence * 100), min = Math.round(d.minConfidence * 100), low = pct < min;
    const node = tree.nodes.find((n) => n.id === d.nodeId);
    latest.replaceChildren(
      el("div", { className: "k", textContent: `Latest decision, at ${node?.label ?? d.nodeId}` }),
      el("div", { className: "question", textContent: node?.question ?? "" }),
      el("div", { className: "answer" }, d.answer, low ? el("span", { className: "low", textContent: "below the minimum, so the agent asked again" }) : ""),
      el("div", { className: "bar" }, el("div", { className: `fill${low ? " low" : ""}`, style: `width:${pct}%` }), el("div", { className: "min", style: `left:${min}%` })),
      el("div", { className: "meta", textContent: `confidence ${pct}%, minimum ${min}% · ${d.module} · ${d.durationMs} ms` }),
      el("p", { className: "reason", textContent: d.reason }));
  } else latest.replaceChildren(el("div", { className: "k", textContent: "No decision yet" }));

  const current = tree.nodes.find((n) => n.id === sum.nodeId);
  const branches = $("branches");
  const taken = d && current && d.nodeId === current.id ? d.answer : null;
  branches.replaceChildren(...(current?.edges ?? []).map((edge) => el("li", { className: edge.answer === taken ? "taken" : "" },
    el("span", { className: "ans", textContent: `${edge.answer}${edge.answer === taken ? " ←" : ""}` }),
    el("span", { className: "goes", textContent: edge.clarify ? "ask again" : edge.disposition ? `end: ${tree.dispositions[edge.disposition]}${edge.action ? `, after ${edge.action}` : ""}` : `${edge.action ? `${edge.action}, then ` : ""}${tree.nodes.find((n) => n.id === edge.to)?.label ?? edge.to}` }),
    el("span", { textContent: edge.min !== undefined && edge.min > 0 ? `≥${Math.round(edge.min * 100)}%` : "" }))));
  if (!current) branches.append(el("li", { textContent: "nothing yet" }));

  $("saidNext").replaceChildren(el("span", { className: "k", textContent: "What the agent said next" }), sum.agentSaid ? sum.agentSaid.text : "nothing yet");
}

// ---- Judge panel ----
function renderJudge(sorted) {
  const sum = core.summarize(sorted);
  const list = $("verdicts");
  list.replaceChildren(...sum.verdicts.map((v) => el("li", { className: v.allowed ? "" : "blocked" },
    el("span", { className: "ruling", textContent: v.allowed ? "allowed" : "blocked" }),
    el("span", { className: "act", textContent: `${v.action}${v.target ? ` ${v.target}` : ""}${v.value !== undefined ? ` = ${v.value}` : ""}` }),
    el("span", { className: "why", textContent: v.reason }))));
  if (!sum.verdicts.length) list.append(el("li", { className: "none" }, el("span", { className: "empty", textContent: state.started ? "No action has needed a ruling yet." : "Rulings appear here as the agent tries to save, book, text, transfer or end." })));
  const score = $("score");
  if (sum.score) {
    score.replaceChildren(el("div", { className: "total" }, `${sum.score.score}`, el("small", { textContent: "post-call score out of 100" })),
      el("ul", {}, ...sum.score.criteria.map((c) => el("li", {}, el("b", { textContent: c.score.toFixed(1) }), `${c.criterion}: ${c.note}`))));
  } else score.replaceChildren();
}

// ---- End-of-call sheet ----
function renderSummary(sorted) {
  const sum = core.summarize(sorted);
  const sheet = $("summary");
  sheet.hidden = !sum.ended;
  if (!sum.ended) return;
  const outcome = sorted.find((e) => e.type === "call_outcome")?.data;
  $("sumOutcome").textContent = outcome?.status === "abandoned" ? `Abandoned at ${clockText(state.nowMs)}: ${outcome.reason}` : summary.outcome;
  $("sumDisposition").textContent = sum.disposition ? tree.dispositions[sum.disposition] : "none";
  $("sumScore").textContent = sum.score ? `${sum.score.score} of 100` : "not scored";
  $("sumHandoff").textContent = sum.disposition ? fill(summary.handoffNote) : "No handoff note: the call ended without a disposition.";
  const tbody = $("sumFields").tBodies[0];
  tbody.replaceChildren(...(sum.disposition ? filled(summary.quoteFields) : []).map((f) => el("tr", { className: f.value === "not saved" ? "refused" : "" },
    el("td", { className: "f", textContent: f.field }), el("td", { className: "val", textContent: f.value }), el("td", { className: "ev", textContent: f.evidence }))));
}

function render() {
  const sorted = eventsNow();
  renderRecord(sorted);
  renderRoute(sorted);
  renderJudge(sorted);
  renderSummary(sorted);
  setTransport();
}

// Deep link for screenshots and review: /mock?t=38000 opens paused at that moment; t=end at the end.
const params = new URLSearchParams(location.search);
if (params.has("lead")) { $("lead").value = params.get("lead"); state.lead = leads.find((l) => l.id === $("lead").value) ?? leads[0]; }
renderSetup();
if (params.has("t")) {
  state.started = true;
  state.nowMs = params.get("t") === "end" ? TOTAL_MS : Math.min(TOTAL_MS, Math.max(0, Number(params.get("t")) || 0));
  if (params.get("context") === "open") $("context").open = true;
}
render();

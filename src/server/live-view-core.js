/**
 * Pure logic for the live views: no page access, so the server tests can run
 * it directly and the page loads the same file. Events may arrive in any
 * order and more than once; every derived list is rebuilt from the whole set,
 * ordered by milliseconds since call start (`atMs`), then by sequence number.
 */

const TRANSCRIPT_TYPES = new Set(["transcript_partial", "transcript_final", "turn"]);

/** A new empty view. Events are kept by record id and in-record sequence number, so a replayed event is not added twice. */
export function createView() {
  return { events: new Map() };
}

/** Adds one event. Returns false when it was already there. */
export function ingest(view, event) {
  const key = `${event.recordId}:${event.recordSeq}`;
  if (view.events.has(key)) return false;
  view.events.set(key, event);
  return true;
}

/** Call ids seen so far, newest activity last. Text threads have no call id. */
export function callIdsOf(view) {
  const last = new Map();
  for (const e of view.events.values()) if (e.callId) last.set(e.callId, Math.max(last.get(e.callId) ?? 0, e.seq));
  return [...last.entries()].sort((a, b) => a[1] - b[1]).map(([id]) => id);
}

/** The call to follow when none is pinned: the one whose newest event came last. */
export function latestCallId(view) {
  const ids = callIdsOf(view);
  return ids.length ? ids[ids.length - 1] : null;
}

/**
 * The events of one call, each with a usable `ms`. Records written before
 * `atMs` existed get it from the ISO time relative to the first event.
 */
export function eventsFor(events, callId) {
  const mine = [...events].filter((e) => callId === null || callId === undefined || e.callId === callId);
  const first = mine.reduce((m, e) => Math.min(m, Date.parse(e.at)), Infinity);
  return mine
    .map((e) => ({ ...e, ms: Number.isFinite(e.atMs) ? e.atMs : Math.max(0, Date.parse(e.at) - first) }))
    .sort((a, b) => a.ms - b.ms || a.seq - b.seq);
}

/** Merges partial and final events into one line per speaker and turn. */
export function buildTranscript(sorted) {
  const lines = new Map();
  for (const e of sorted) {
    if (!TRANSCRIPT_TYPES.has(e.type) || e.data?.spoken === false) continue;
    const role = String(e.data?.role ?? "system");
    const key = `${role}:${e.data?.turnIndex ?? e.seq}`;
    let line = lines.get(key);
    if (!line) {
      line = { key, role, text: "", final: false, ms: e.ms, seq: e.seq, endMs: e.ms };
      lines.set(key, line);
    }
    const isFinal = e.type !== "transcript_partial";
    // A final line never goes back to a partial, even if a late partial arrives.
    if (isFinal || !line.final) line.text = String(e.data?.text ?? "");
    if (isFinal) line.final = true;
    line.endMs = Math.max(line.endMs, e.ms);
  }
  return [...lines.values()].sort((a, b) => a.ms - b.ms || a.seq - b.seq);
}

const LINE_TYPES = new Set(["transcript_partial", "transcript_final", "turn", "text"]);

/** One short label for a trace row, and whether it is a failure or a block. */
export function describeRow(e) {
  const d = e.data ?? {};
  switch (e.type) {
    case "tool_call":
      return { kind: "tool", bad: d.success === false, text: `tool ${d.tool ?? "?"} ${d.success === false ? "FAILED" : "ok"}${d.durationMs !== undefined ? ` ${d.durationMs}ms` : ""}${d.success === false && d.reason ? ` (${d.reason})` : ""}` };
    case "compliance_check":
      // A gate test mode skipped, or the test-mode marker itself: never shown as passed.
      if (d.passed === null || d.skipped) return { kind: "check", bad: false, text: `check ${d.check ?? "?"} ${d.result ?? "skipped: test mode"}` };
      return { kind: "check", bad: d.passed === false, text: `check ${d.check ?? "?"} ${d.passed === false ? "BLOCKED" : "passed"}${d.reason ? `: ${d.reason}` : ""}` };
    case "decision":
      return { kind: "decision", bad: d.routed === "clarify", text: `decision ${d.answer ?? "?"} (${Math.round(Number(d.confidence ?? 0) * 100)}%, needs ${Math.round(Number(d.minConfidence ?? 0) * 100)}%) via ${d.module ?? "?"}: ${d.reason ?? ""}` };
    case "judge_verdict":
      return { kind: "judge", bad: d.allowed === false, text: `judge ${d.action ?? "?"} ${d.allowed === false ? "BLOCKED" : "allowed"}: ${d.reason ?? ""}` };
    case "node_enter":
      return { kind: "node", bad: false, text: `entered ${d.label ?? d.nodeId ?? "?"}` };
    case "disposition":
      return { kind: "disposition", bad: false, text: `disposition ${d.value ?? "?"}` };
    case "judge_score":
      return { kind: "judge", bad: false, text: `post-call score ${d.score ?? "?"}` };
    case "call_outcome":
      return { kind: "outcome", bad: d.status === "failed", text: `call ${d.status ?? "ended"}${d.reason ? `: ${d.reason}` : ""}` };
    default:
      return { kind: e.type, bad: false, text: `${e.type}${d.status ? ` ${d.status}` : ""}` };
  }
}

/**
 * Lines up trace rows with transcript lines. A row belongs to the latest
 * transcript line that started at or before it (milliseconds, then sequence
 * number); rows before any line belong to the start of the call (`line` null).
 */
export function align(sorted) {
  const lines = buildTranscript(sorted);
  const groups = [{ line: null, rows: [] }, ...lines.map((line) => ({ line, rows: [] }))];
  for (const e of sorted) {
    if (LINE_TYPES.has(e.type)) continue;
    let target = 0;
    for (let i = 0; i < lines.length; i += 1) {
      const l = lines[i];
      if (l.ms < e.ms || (l.ms === e.ms && l.seq < e.seq)) target = i + 1;
      else break;
    }
    groups[target].rows.push({ event: e, ...describeRow(e) });
  }
  return groups.filter((g) => g.line || g.rows.length);
}

/** The state shown in the tree and disposition panel. */
export function summarize(sorted, recordJudge) {
  const out = { nodeId: null, disposition: null, decision: null, agentSaid: null, verdicts: [], score: recordJudge ?? null, ended: false };
  for (const e of sorted) {
    const d = e.data ?? {};
    if (e.type === "node_enter") out.nodeId = d.nodeId ?? null;
    else if (e.type === "disposition") out.disposition = d.value ?? null;
    // The live judge emits its own decision events (kind "live_judge"); they belong in the judge window, not the Now panel.
    else if (e.type === "decision" && d.kind !== "live_judge") out.decision = d;
    else if (e.type === "judge_verdict") out.verdicts.push(d);
    else if (e.type === "judge_score") out.score = d;
    else if (e.type === "call_outcome") out.ended = true;
  }
  const agent = buildTranscript(sorted).filter((l) => l.role === "agent");
  out.agentSaid = agent.length ? agent[agent.length - 1] : null;
  return out;
}

/**
 * Column layout for the tree: depth from the start node, one row per node in
 * a column. Nodes the start cannot reach go in a last column.
 */
export function layoutTree(tree) {
  const byId = new Map(tree.nodes.map((n) => [n.id, n]));
  const depth = new Map();
  const queue = [tree.start];
  depth.set(tree.start, 0);
  while (queue.length) {
    const id = queue.shift();
    for (const edge of byId.get(id)?.edges ?? []) {
      if (edge.to && byId.has(edge.to) && !depth.has(edge.to)) {
        depth.set(edge.to, depth.get(id) + 1);
        queue.push(edge.to);
      }
    }
  }
  const unreachable = Math.max(0, ...depth.values()) + 1;
  const rowsInColumn = new Map();
  const placed = tree.nodes.map((n) => {
    const col = depth.get(n.id) ?? unreachable;
    const row = rowsInColumn.get(col) ?? 0;
    rowsInColumn.set(col, row + 1);
    return { node: n, col, row };
  });
  return { placed, columns: Math.max(...placed.map((p) => p.col)) + 1, rows: Math.max(...rowsInColumn.values()) };
}

/** One node from the tree served by `GET /api/tree`. */
export function findTreeNode(tree, nodeId) {
  if (!nodeId) return null;
  return tree.nodes.find((n) => n.id === nodeId) ?? null;
}

/** Plain label for where an edge leads. */
export function edgeDestination(tree, edge) {
  if (!edge.to) return edge.answer === "unclear" ? "ask again" : "stay";
  const target = findTreeNode(tree, edge.to);
  if (target?.disposition) return `end: ${target.disposition}`;
  return target?.label ?? edge.to;
}

/**
 * The live stage: current node, breadcrumb path, and each outgoing branch with
 * optional per-answer model scores from the latest decision at this node.
 */
export function buildStage(tree, sorted, summary) {
  const node = findTreeNode(tree, summary.nodeId);
  const decision = summary.decision;
  const scoresAtNode =
    node && decision && decision.nodeId === node.id && Array.isArray(decision.scores) ? decision.scores : [];
  const scoreByAnswer = new Map(scoresAtNode.map((s) => [s.answer, s.confidence]));
  const taken =
    node && decision && decision.nodeId === node.id
      ? decision.routed === "clarify"
        ? null
        : decision.answer
      : null;
  const bars = node?.bars ?? {};
  const branches = (node?.edges ?? [])
    .filter((edge) => edge.answer !== "next")
    .map((edge) => ({
      answer: edge.answer,
      destination: edgeDestination(tree, edge),
      minConfidence: bars[edge.answer] ?? node?.minConfidence ?? null,
      modelConfidence: scoreByAnswer.has(edge.answer) ? scoreByAnswer.get(edge.answer) : null,
      taken: taken !== null && edge.answer === taken,
      clarify: !edge.to || edge.answer === "unclear",
    }));
  const path = [];
  for (const e of sorted) {
    if (e.type !== "node_enter") continue;
    const id = e.data?.nodeId;
    if (!id) continue;
    if (!path.length || path[path.length - 1].nodeId !== id) {
      path.push({ nodeId: id, label: e.data?.label ?? id, ms: e.ms });
    }
  }
  return {
    nodeId: summary.nodeId,
    label: node?.label ?? null,
    question: node?.question ?? null,
    module: decision?.module ?? null,
    branches,
    path,
  };
}

/**
 * One row per `judge_verdict`, oldest first. The live judge also emits a
 * `decision` event (kind "live_judge") just before its verdict; the nearest
 * unused one for the same action supplies the model, its answer, confidence, block threshold and
 * latency. Rule-only verdicts have none of those, so they stay null. Only
 * fields the events carry are read; caller words are never copied
 * (the verdict's `reason` is one plain sentence, `evidence` is ignored).
 */
export function judgeRows(sorted) {
  const pending = [];
  const rows = [];
  for (const e of sorted) {
    const d = e.data ?? {};
    if (e.type === "decision" && d.kind === "live_judge") pending.push(d);
    else if (e.type === "judge_verdict") {
      const at = pending.findIndex((p) => p.action === d.action);
      const model = at >= 0 ? pending.splice(at, 1)[0] : null;
      const lines = Array.isArray(d.scores) ? d.scores : [];
      rows.push({
        key: `${e.recordId ?? ""}:${e.recordSeq ?? e.seq}`,
        ms: e.ms,
        action: d.action ?? "?",
        allowed: d.allowed !== false,
        reasonCode: d.reason ?? "",
        confidence: model && Number.isFinite(model.confidence) ? model.confidence : null,
        answer: model && typeof model.answer === "string" ? model.answer : null,
        blockThreshold: model && Number.isFinite(model.blockThreshold) ? model.blockThreshold : null,
        failureReason: model && typeof model.failureReason === "string" ? model.failureReason : null,
        latencyMs: model && Number.isFinite(model.latencyMs) ? model.latencyMs : null,
        attemptCount: model && Number.isFinite(model.attemptCount) ? model.attemptCount : null,
        attempts: model && Array.isArray(model.attempts)
          ? model.attempts.map((a) => ({ n: Number(a?.n), outcome: String(a?.outcome ?? "?"), latencyMs: Number(a?.latencyMs) }))
          : [],
        modelId: model ? model.modelId ?? null : null,
        modelKind: model ? model.modelKind ?? null : null,
        passed: lines.filter((l) => Number(l.score) >= 0.5).length,
        checked: lines.length,
      });
    }
  }
  return rows;
}

/** Each attempt as "outcome latency", for example "1 timeout 3000ms, 2 answered 1500ms". Codes and numbers only. */
export function attemptsText(row) {
  return (row.attempts ?? []).map((a) => `${a.n} ${a.outcome} ${a.latencyMs}ms`).join(", ");
}

/** A compact line for one judge row, for the transcript column. */
export function judgeLine(row) {
  const parts = [`${row.allowed ? "allowed" : "REFUSED"} ${row.action}`];
  if (row.checked) parts.push(`${row.passed}/${row.checked} checks`);
  if (row.answer != null) parts.push(`model said ${row.answer}`);
  if (row.confidence != null) parts.push(`${Math.round(row.confidence * 100)}%`);
  if (row.modelId === "none") parts.push("no decision model");
  else if (row.failureReason != null) parts.push(`no model answer (${row.failureReason})`);
  if (row.latencyMs != null) parts.push(`${row.latencyMs}ms`);
  if (row.attemptCount > 1) parts.push(`${row.attemptCount} attempts (${attemptsText(row)})`);
  return parts.join(" · ");
}

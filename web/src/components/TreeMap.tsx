import * as core from "../../../src/server/live-view-core.js";
import type { TreeJson } from "../../../src/server/live-view-core.js";
import { useMemo } from "react";
import { foldTree, words } from "@/lib/tree";

const W = 150, H = 40, GX = 40, GY = 22;

/** The decision tree as an SVG map: current node filled, visited nodes tinted, the taken edge heavy. */
export function TreeMap({ tree: full, current: rawCurrent, visited: rawVisited, takenAnswer }: {
  tree: TreeJson | null;
  current: string | null;
  visited: Set<string>;
  takenAnswer: string | null;
}) {
  const folded = useMemo(() => (full ? foldTree(full) : null), [full]);
  if (!folded) return <p className="text-sm text-muted-foreground">Loading…</p>;
  const tree = folded.tree;
  const current = folded.resolve(rawCurrent);
  const visited = new Set([...rawVisited].map((v) => folded.resolve(v)!));
  const { placed, columns, rows } = core.layoutTree(tree);
  const pos = new Map(placed.map((p) => [p.node.id, { x: p.col * (W + GX) + 4, y: p.row * (H + GY) + 4 }]));
  return (
    <svg width={columns * (W + GX)} height={rows * (H + GY) + 4} role="img" aria-label="Decision tree map" className="block max-w-none text-[11px]">
      {placed.flatMap(({ node }) => node.edges.map((edge, i) => {
        const a = pos.get(node.id)!;
        const b = edge.to ? pos.get(edge.to) : undefined;
        if (!b) return null;
        const x1 = a.x + W, y1 = a.y + H / 2, x2 = b.x, y2 = b.y + H / 2;
        const hot = node.id === current && (edge.answer === takenAnswer || (!takenAnswer && edge.answer !== "next"));
        const stroke = hot ? (edge.answer === takenAnswer ? "#1f7c74" : "#9aa3af") : "#d5d9e0";
        return (
          <g key={`${node.id}-${i}`}>
            <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={stroke} strokeWidth={edge.answer === takenAnswer ? 2.5 : hot ? 1.5 : 1} />
            <text x={(x1 + x2) / 2} y={(y1 + y2) / 2 - 2} textAnchor="middle" fill={hot ? "#1f7c74" : "#5b6573"}>{words(edge.answer)}</text>
          </g>
        );
      }))}
      {placed.map(({ node }) => {
        const p = pos.get(node.id)!;
        const on = node.id === current;
        return (
          <g key={node.id}>
            <rect x={p.x} y={p.y} width={W} height={H} rx={6} fill={on ? "#1f7c74" : visited.has(node.id) ? "#e6f2ee" : "#fff"} stroke="#1f7c74" />
            <text x={p.x + 6} y={p.y + 16} fill={on ? "#fff" : "#1b1f24"}>{node.label.slice(0, 24)}</text>
            <text x={p.x + 6} y={p.y + 31} fill={on ? "#c4cad3" : "#5b6573"}>{node.disposition ? `ends: ${words(node.disposition)}`.slice(0, 26) : ""}</text>
          </g>
        );
      })}
    </svg>
  );
}

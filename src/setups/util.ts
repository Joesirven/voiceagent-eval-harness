/** Small helpers shared by the lead setup modules. */

import type { Row } from "../store/database-client.js";

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export function text(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

export function num(v: unknown): number | undefined {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? n : undefined;
}

export function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

export function textList(v: unknown): string[] {
  return Array.isArray(v) ? v.map(text).filter((s): s is string => s !== undefined) : [];
}

export function newest(rows: Row[], column: string): Row[] {
  return [...rows].sort((a, b) => String(b[column] ?? "").localeCompare(String(a[column] ?? "")));
}

/** Fisher-Yates with an injectable random source, so tests are repeatable. */
export function shuffled<T>(items: T[], random: () => number = Math.random): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

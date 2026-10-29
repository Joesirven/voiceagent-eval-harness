import { readFileSync } from "node:fs";

/** Reads one of the JSON files in src/behaviour/data. Parsed fresh on each call; callers cache. */
export function readDataFile<T>(name: string): T {
  return JSON.parse(readFileSync(new URL(`./data/${name}`, import.meta.url), "utf8")) as T;
}

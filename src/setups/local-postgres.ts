/** Local Postgres support for optional harness run storage. */

import { execFile } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { DATA_DIR_ENV, DEFAULT_DATA_DIR } from "../store/held-stops.js";

export const LOCAL_DB_ENV_FILE_ENV = "VOICE_HARNESS_DATABASE_ENV_FILE";
export const HARNESS_DB_ENV = "VOICE_HARNESS_DATABASE_KIND";
const VARIABLE = "VOICE_HARNESS_DATABASE_URL";
const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

export type HarnessDbKind = "local";

export interface LocalPostgresTarget {
  libpqEnv: Record<string, string>;
}

export function assertLocalPostgres(rawUrl: string, kind: HarnessDbKind = "local"): LocalPostgresTarget {
  if (kind !== "local") throw new Error("harness_db_kind_unknown");
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("local_db_url_invalid");
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") throw new Error("local_db_url_not_postgres");
  const host = parsed.hostname.toLowerCase();
  if (!LOOPBACK.has(host)) throw new Error("local_db_url_is_not_this_machine");
  let user: string;
  let password: string;
  let database: string;
  try {
    user = decodeURIComponent(parsed.username);
    password = decodeURIComponent(parsed.password);
    database = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  } catch {
    throw new Error("local_db_url_invalid");
  }
  if (!user || !database) throw new Error("local_db_url_invalid");
  if (!password) throw new Error("local_db_url_missing_password");
  return {
    libpqEnv: {
      PGHOST: host.replace(/^\[|\]$/g, ""),
      PGPORT: parsed.port || "5432",
      PGUSER: user,
      PGPASSWORD: password,
      PGDATABASE: database,
      PGCONNECT_TIMEOUT: "10",
      PGSSLMODE: "disable",
    },
  };
}

export interface DotenvFs {
  mode(path: string): number;
  read(path: string): string;
}

const nodeFs: DotenvFs = {
  mode: (path) => statSync(path).mode,
  read: (path) => readFileSync(path, "utf8"),
};

export function defaultLocalDbEnvFile(env: Record<string, string | undefined> = process.env): string {
  return env[LOCAL_DB_ENV_FILE_ENV] ?? join(resolve(env[DATA_DIR_ENV] ?? DEFAULT_DATA_DIR), "database.env");
}

function readDatabaseUrl(path: string, fs: DotenvFs): string {
  let text: string;
  try {
    if ((fs.mode(path) & 0o077) !== 0) throw new Error("local_db_env_file_permissions_too_open");
    text = fs.read(path);
  } catch (error) {
    if (error instanceof Error && error.message === "local_db_env_file_permissions_too_open") throw error;
    throw new Error("local_db_env_file_unreadable");
  }
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim().replace(/^export\s+/, "");
    if (!line.startsWith(`${VARIABLE}=`)) continue;
    const value = line.slice(VARIABLE.length + 1).trim().replace(/^(["'])(.*)\1$/, "$2");
    if (value) return value;
  }
  throw new Error(`local_db_settings_missing_${VARIABLE}`);
}

export function harnessDbKind(env: Record<string, string | undefined> = process.env): HarnessDbKind {
  const kind = env[HARNESS_DB_ENV] ?? "local";
  if (kind !== "local") throw new Error("harness_db_kind_unknown");
  return kind;
}

export function loadLocalPostgres(env: Record<string, string | undefined> = process.env, fs: DotenvFs = nodeFs): LocalPostgresTarget {
  return assertLocalPostgres(readDatabaseUrl(defaultLocalDbEnvFile(env), fs), harnessDbKind(env));
}

export interface SqlRunner {
  json(sql: string): Promise<unknown>;
}

export type ExecFile = (
  file: string,
  args: string[],
  options: { env: Record<string, string>; timeout: number; maxBuffer: number },
  callback: (error: Error | null, stdout: string, stderr: string) => void,
) => { stdin: { end(input: string): void } | null };

const PSQL_ARGS = ["-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-f", "-"];

export function createPsqlRunner(target: LocalPostgresTarget, exec: ExecFile = execFile as unknown as ExecFile): SqlRunner {
  return {
    json(sql) {
      return new Promise((resolveJson, reject) => {
        const child = exec(
          "psql",
          PSQL_ARGS,
          { env: { PATH: process.env.PATH ?? "", ...target.libpqEnv }, timeout: 30_000, maxBuffer: 64 * 1024 * 1024 },
          (error, stdout) => {
            if (error) return reject(new Error("local_db_error"));
            try {
              resolveJson(JSON.parse(stdout.trim() || "null"));
            } catch {
              reject(new Error("local_db_unreadable_answer"));
            }
          },
        );
        child.stdin?.end(sql);
      });
    },
  };
}

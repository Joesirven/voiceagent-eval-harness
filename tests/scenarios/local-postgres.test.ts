import { describe, expect, it } from "vitest";
import { assertLocalPostgres, createPsqlRunner, loadLocalPostgres, type DotenvFs, type ExecFile } from "../../src/setups/local-postgres.js";

describe("local Postgres target", () => {
  it("accepts loopback and keeps the password out of command arguments", async () => {
    const target = assertLocalPostgres("postgresql://harness:secret@127.0.0.1:55432/harness");
    expect(target.libpqEnv).toMatchObject({ PGHOST: "127.0.0.1", PGPORT: "55432", PGUSER: "harness", PGPASSWORD: "secret", PGSSLMODE: "disable" });
    let input = "";
    const exec: ExecFile = (_file, args, options, callback) => {
      expect(args.join(" ")).not.toContain("secret");
      expect(options.env.PGPASSWORD).toBe("secret");
      return { stdin: { end: (value) => { input = value; callback(null, '{"ok":true}\n', ""); } } };
    };
    await expect(createPsqlRunner(target, exec).json("select 1")).resolves.toEqual({ ok: true });
    expect(input).toBe("select 1");
  });

  it.each([
    "postgresql://u:p@database.example.com/db",
    "postgresql://u:p@192.0.2.10/db",
  ])("refuses a non-loopback host: %s", (url) => {
    expect(() => assertLocalPostgres(url)).toThrow("local_db_url_is_not_this_machine");
  });

  it("loads the URL from a private environment file", () => {
    const fs: DotenvFs = { mode: () => 0o600, read: () => "VOICE_HARNESS_DATABASE_URL=postgresql://u:p@localhost:54329/db\n" };
    const target = loadLocalPostgres({ VOICE_HARNESS_DATABASE_ENV_FILE: "/private/database.env" }, fs);
    expect(target.libpqEnv.PGPORT).toBe("54329");
  });

  it("refuses an open environment file", () => {
    const fs: DotenvFs = { mode: () => 0o644, read: () => "" };
    expect(() => loadLocalPostgres({ VOICE_HARNESS_DATABASE_ENV_FILE: "/private/database.env" }, fs)).toThrow("local_db_env_file_permissions_too_open");
  });
});

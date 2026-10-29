import type { DbClient, Row, Scalar, SelectQuery } from "../../src/store/database-client.js";

/** In-memory stand-in for the database client. No network. */
export class FakeDb implements DbClient {
  tables: Record<string, Row[]> = {};
  calls: Array<{ op: string; table: string }> = [];
  /** Bump updated_at on every update, like a real trigger would. */
  private clock = 0;

  /** What the fake database function answers; default reachable. */
  reach: { allowed: boolean; reason: string | null } | "empty" = { allowed: true, reason: null };
  rpcCalls: Array<{ name: string; args: Row }> = [];

  /** Tables that do not exist yet: any read or write on one fails like a 404 from the database. */
  missingTables = new Set<string>();

  /** Make crm_record_stop fail, like a database error. */
  failStop = false;

  async rpc(name: string, args: Row): Promise<Row[]> {
    this.rpcCalls.push({ name, args });
    if (name === "crm_record_stop") {
      if (this.failStop) throw new Error("crm_db_error:POST:rpc/crm_record_stop:500");
      const revoke = (args.p_revoke_rows as Row[]) ?? [];
      const suppress = (args.p_suppression_rows as Row[]) ?? [];
      const proofs = new Set((this.tables.crm_consent_event ?? []).map((e) => e.proof_ref));
      const fresh = args.p_replay ? revoke.filter((r) => !proofs.has(r.proof_ref)) : revoke;
      for (const r of fresh) this.rows("crm_consent_event").push(structuredClone(r));
      for (const r of suppress) {
        this.rows("crm_suppression").push({
          ...structuredClone(r),
          phone_key: String(r.phone).replace(/\D/g, "").slice(-10),
        });
      }
      return [{ revoked: fresh.length, suppressed: suppress.length }];
    }
    return this.reach === "empty" ? [] : [{ ...this.reach }];
  }

  seed(table: string, ...rows: Row[]): this {
    (this.tables[table] ??= []).push(...rows);
    return this;
  }

  private rows(table: string): Row[] {
    return (this.tables[table] ??= []);
  }

  private matches(row: Row, eq: Record<string, Scalar> = {}): boolean {
    return Object.entries(eq).every(([k, v]) => String(row[k]) === String(v));
  }

  async select(table: string, q: SelectQuery): Promise<Row[]> {
    this.calls.push({ op: "select", table });
    if (this.missingTables.has(table)) throw new Error(`crm_db_error:GET:${table}:404`);
    let out = this.rows(table).filter(
      (r) =>
        this.matches(r, q.eq) &&
        Object.entries(q.in ?? {}).every(([k, vs]) => vs.map(String).includes(String(r[k]))) &&
        (q.isNull ?? []).every((c) => r[c] === null || r[c] === undefined),
    );
    if (q.order) {
      const { column, ascending } = q.order;
      out = [...out].sort((a, b) => (String(a[column]) < String(b[column]) ? -1 : 1) * (ascending ? 1 : -1));
    }
    return structuredClone(q.limit === undefined ? out : out.slice(0, q.limit));
  }

  async insert(table: string, row: Row, opts?: { ignoreDuplicatesOn?: string }): Promise<Row[]> {
    this.calls.push({ op: "insert", table });
    if (this.missingTables.has(table)) throw new Error(`crm_db_error:POST:${table}:404`);
    if (opts?.ignoreDuplicatesOn) {
      const cols = opts.ignoreDuplicatesOn.split(",");
      if (this.rows(table).some((r) => cols.every((c) => r[c] === row[c]))) return [];
    }
    this.rows(table).push(structuredClone(row));
    return [structuredClone(row)];
  }

  async update(table: string, match: Record<string, Scalar>, patch: Row): Promise<Row[]> {
    this.calls.push({ op: "update", table });
    const hit = this.rows(table).filter((r) => this.matches(r, match));
    for (const r of hit) {
      Object.assign(r, structuredClone(patch));
      this.clock += 1;
      r.updated_at = `2026-10-19T00:00:${String(this.clock).padStart(2, "0")}.000Z`;
    }
    return structuredClone(hit);
  }

  async remove(table: string, match: Record<string, Scalar>): Promise<Row[]> {
    this.calls.push({ op: "remove", table });
    const all = this.rows(table);
    const gone = all.filter((r) => this.matches(r, match));
    this.tables[table] = all.filter((r) => !gone.includes(r));
    return structuredClone(gone);
  }
}

export const LEAD_ID = "11111111-1111-4111-8111-111111111111";
export const AGENCY_ID = "22222222-2222-4222-8222-222222222222";
const ENTITY_ID = "33333333-3333-4333-8333-333333333333";

/** A synthetic CRM-shaped lead in the 555 exchange, with consent on file. */
export function seedCRMLead(db: FakeDb): FakeDb {
  return db
    .seed("crm_lead", {
      id: LEAD_ID,
      agency_id: AGENCY_ID,
      entity_id: ENTITY_ID,
      owner_name: "Pat Example",
      phone: "+15550116",
      attributes: { unrelated_key: { keep: "me" } },
      updated_at: "2026-10-01T00:00:00.000Z",
    })
    .seed("crm_lead_index", {
      entity_id: ENTITY_ID,
      business_name: "Example Roofing",
      owner_name: null,
      phone: null,
      dnc_status: "clear",
    })
    .seed("crm_agency", { id: AGENCY_ID, outbound_config: {} })
    .seed(
      "crm_consent_event",
      { agency_id: AGENCY_ID, contact_id: LEAD_ID, channel: "call", action: "granted", scope: "ai_voice", occurred_at: "2026-10-01T12:00:00.000Z" },
      { agency_id: AGENCY_ID, contact_id: LEAD_ID, channel: "sms", action: "granted", occurred_at: "2026-10-01T12:05:00.000Z" },
    )
    .seed("crm_task", {
      contact_id: LEAD_ID,
      kind: "callback",
      status: "open",
      due_at: "2026-10-15T14:00:00.000Z",
      created_at: "2026-10-01T12:10:00.000Z",
    })
    .seed("crm_interaction_event", {
      contact_id: LEAD_ID,
      channel: "call",
      occurred_at: "2026-09-30T15:00:00.000Z",
      title: "Call",
      snippet: "Asked about an auto quote",
    });
}

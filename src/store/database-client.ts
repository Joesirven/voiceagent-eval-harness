/** Minimal row-store interface for optional external adapters and test fakes. */

export type Row = Record<string, unknown>;
export type Scalar = string | number | boolean;

export interface SelectQuery {
  columns: string;
  eq?: Record<string, Scalar>;
  in?: Record<string, Scalar[]>;
  isNull?: string[];
  gte?: Record<string, Scalar>;
  lte?: Record<string, Scalar>;
  ilike?: Record<string, string>;
  order?: { column: string; ascending: boolean };
  limit?: number;
  offset?: number;
}

export interface DbClient {
  select(table: string, query: SelectQuery): Promise<Row[]>;
  insert(table: string, row: Row, opts?: { ignoreDuplicatesOn?: string }): Promise<Row[]>;
  update(table: string, match: Record<string, Scalar>, patch: Row): Promise<Row[]>;
  remove(table: string, match: Record<string, Scalar>): Promise<Row[]>;
  rpc(name: string, args: Row): Promise<Row[]>;
}

import postgres, { type Sql } from "postgres";

let sql: Sql | undefined;

/**
 * A tagged-template Postgres client. Interpolations are always parameterised,
 * so `sql\`select * from users where id = ${id}\`` cannot be injected into.
 *
 *   const rows = await ctx.sql`select id, email from users where active = true`;
 */
export function createSql(): Sql {
  if (sql) return sql;

  const url = process.env.POSTGRES_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error("POSTGRES_URL is not set");

  sql = postgres(url, {
    max: Number(process.env.POSTGRES_POOL_MAX ?? 5),
    idle_timeout: 30,
    connect_timeout: 15,
    onnotice: () => {},
  });
  return sql;
}

export async function closeSql(): Promise<void> {
  await sql?.end({ timeout: 5 });
  sql = undefined;
}

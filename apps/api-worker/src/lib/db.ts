// A new postgres.js client PER REQUEST through Hyperdrive (Hyperdrive pools). Clients are closed by
// closeDbs() once the handler has finished. Calling sql.end() up front would reject every later query
// with CONNECTION_ENDED.
import postgres from 'postgres';

export type Sql = ReturnType<typeof postgres>;
/** The only part of the execution context we use (Hono and the runtime declare different full types). */
export type Ctx = { waitUntil(promise: Promise<unknown>): void };

export function db(env: Env, ctx: Ctx): Sql {
  const u = new URL(env.HYPERDRIVE!.connectionString);
  // Local dev passes DATABASE_URL straight through; postgres.js would forward an sslrootcert parameter.
  u.searchParams.delete('sslrootcert');
  const sql = postgres(u.toString(), { max: 5, fetch_types: false, prepare: true, onnotice: () => {} });
  const list = open.get(ctx) ?? [];
  list.push(sql);
  open.set(ctx, list);
  return sql;
}

const open = new WeakMap<Ctx, Sql[]>();

/** Close this request's clients after the response is built (called from the /api/* middleware). */
export function closeDbs(ctx: Ctx): void {
  const list = open.get(ctx);
  if (!list) return;
  open.delete(ctx);
  ctx.waitUntil(Promise.all(list.map((s) => s.end({ timeout: 5 }))));
}

/**
 * For callers that have no request context (the copilot's Durable Object): runs `fn` with a context whose
 * Postgres clients are closed, and awaited, once it finishes.
 */
export async function withDb<T>(fn: (ctx: Ctx) => Promise<T>): Promise<T> {
  const pending: Promise<unknown>[] = [];
  const ctx: Ctx = { waitUntil: (p) => void pending.push(p) };
  try {
    return await fn(ctx);
  } finally {
    closeDbs(ctx);
    await Promise.allSettled(pending);
  }
}

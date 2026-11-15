import { routeAgentRequest } from "agents";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { isAllowedOrigin, parseAllowedOrigins } from "./origins";

export { FireCopilotAgent } from "./copilot/agent";

const allowed = (env: Env) => parseAllowedOrigins(env.ALLOWED_ORIGINS);

const app = new Hono<{ Bindings: Env }>();

app.use("*", (c, next) =>
  cors({
    origin: (origin) => (isAllowedOrigin(origin, allowed(c.env)) ? origin : null),
    allowMethods: ["GET", "POST", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
    maxAge: 600
  })(c, next)
);

// TODO(api team): fill in Postgres / D1 / KV latencies per SPEC §3.
app.get("/api/health", (c) =>
  c.json({ ok: true, chat: { model: c.env.CHAT_MODEL, dataSource: c.env.FIRE_DATA_SOURCE } })
);

// Chat copilot: WebSocket + HTTP at /agents/fire-copilot-agent/<sessionId>.
app.all("/agents/*", async (c) => {
  const origin = c.req.header("Origin");
  const allowOrigin = origin && isAllowedOrigin(origin, allowed(c.env)) ? origin : null;
  if (origin && !allowOrigin) return c.json({ error: { code: "forbidden_origin", message: "Origin not allowed" } }, 403);
  const res = await routeAgentRequest(c.req.raw, c.env, {
    cors: allowOrigin
      ? {
          "Access-Control-Allow-Origin": allowOrigin,
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
          Vary: "Origin"
        }
      : undefined
  });
  return res ?? c.json({ error: { code: "not_found", message: "No such agent" } }, 404);
});

app.notFound((c) => c.json({ error: { code: "not_found", message: "Not found" } }, 404));

export default app;

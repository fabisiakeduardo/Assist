import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import type { Store } from "./store.js";
import type { User } from "./domain/types.js";

// ─── Servidor HTTP ───────────────────────────────────────────────────────────

export interface AppDeps {
  store: Store;
}

declare module "fastify" {
  interface FastifyRequest {
    user: User | null;
    sessionToken: string | null;
  }
}

export const SESSION_COOKIE = "nexo_sid";

export async function buildServer(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  await app.register(cors, {
    origin: true,
    credentials: true,
  });
  await app.register(cookie);

  // auth: cookie de sessão → usuário no request
  app.decorateRequest("user", null);
  app.decorateRequest("sessionToken", null);
  app.addHook("preHandler", async (req) => {
    const token = req.cookies[SESSION_COOKIE];
    if (token) {
      req.sessionToken = token;
      req.user = deps.store.userBySession(token);
    }
  });

  app.get("/health", async () => ({ ok: true, service: "nexo-assist-api" }));

  return app;
}

// ─── guards ──────────────────────────────────────────────────────────────────

export function requireUser(req: FastifyRequest, reply: FastifyReply): User | null {
  if (!req.user) {
    void reply.code(401).send({ error: "unauthenticated" });
    return null;
  }
  return req.user;
}

export function requireEmployee(req: FastifyRequest, reply: FastifyReply): User | null {
  const u = requireUser(req, reply);
  if (!u) return null;
  if (u.role !== "employee") {
    void reply.code(403).send({ error: "employee_only" });
    return null;
  }
  return u;
}

export function requireAnalyst(req: FastifyRequest, reply: FastifyReply): User | null {
  const u = requireUser(req, reply);
  if (!u) return null;
  if (u.role !== "analyst") {
    void reply.code(403).send({ error: "analyst_only" });
    return null;
  }
  return u;
}

// ─── SSE helper ──────────────────────────────────────────────────────────────

export function openSse(req: FastifyRequest, reply: FastifyReply) {
  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  reply.raw.write(": connected\n\n");
  const send = (payload: unknown) => {
    reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`);
  };
  const heartbeat = setInterval(() => reply.raw.write(": ping\n\n"), 25_000);
  const close = () => {
    clearInterval(heartbeat);
    try {
      reply.raw.end();
    } catch {
      /* já fechado */
    }
  };
  req.raw.on("close", close);
  return { send, close };
}

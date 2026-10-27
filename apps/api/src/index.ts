import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fastifyStatic from "@fastify/static";
import { config, hasLlmKey, oidcEnabled } from "./config.js";
import { getDb } from "./db.js";
import { Store } from "./store.js";
import { seed } from "./seed.js";
import { TicketService } from "./services/ticketService.js";
import { HelpCenter } from "./services/helpCenter.js";
import { RealtimeHub } from "./realtime.js";
import { AgentRunner } from "./services/runner.js";
import { EscalationJob } from "./services/escalation.js";
import { OidcClient } from "./services/oidc.js";
import { ScriptedEngine } from "./agent/scripted.js";
import { MastraEngine } from "./agent/mastra.js";
import { buildServer } from "./server.js";
import { registerRoutes } from "./routes.js";

// ─── bootstrap ───────────────────────────────────────────────────────────────

const here = path.dirname(fileURLToPath(import.meta.url)); // src/ (dev) ou dist/ (build)

const store = new Store(getDb());
seed(store);

const tickets = new TicketService(store);
const help = new HelpCenter(store);
const hub = new RealtimeHub();

const engineKind =
  config.agentEngine === "auto" ? (hasLlmKey() ? "mastra" : "scripted") : config.agentEngine;

const engine =
  engineKind === "mastra"
    ? new MastraEngine()
    : new ScriptedEngine({ stepMs: 200, wordMs: 12 });

const runner = new AgentRunner({ store, tickets, help }, engine, hub);

// job de escalonamento: conversas aguardando analista com SLA vencido sobem p/ N2
const escalation = new EscalationJob(store, hub);
escalation.start();

// SSO corporativo — ativo quando OIDC_ISSUER + OIDC_CLIENT_ID estão configurados
const oidc = oidcEnabled ? new OidcClient(config.oidc) : undefined;

const app = await buildServer({ store });

// API inteira sob /api — dev (proxy do Vite) e produção usam o mesmo caminho
await app.register(
  async (api) => {
    registerRoutes(api, { store, tickets, help, runner, hub, engineKind, oidc });
  },
  { prefix: "/api" },
);

// modo produção: se o build do front existe, a API serve a SPA (deploy único)
const webDist = path.resolve(here, "../../web/dist");
if (existsSync(webDist)) {
  await app.register(fastifyStatic, { root: webDist });
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith("/api/") || req.url === "/health") {
      return reply.code(404).send({ error: "not_found" });
    }
    return reply.sendFile("index.html"); // SPA fallback (React Router)
  });
  console.log(`[nexo-api] servindo o build do web em ${webDist}`);
}

try {
  await app.listen({ port: config.port, host: config.host });
  console.log(`[nexo-api] ouvindo em http://localhost:${config.port}`);
  console.log(`[nexo-api] engine do agent: ${engineKind}${engineKind === "mastra" ? ` (${config.llmModel})` : ""}`);
  console.log(`[nexo-api] sso (oidc): ${oidcEnabled ? config.oidc.issuer : "desligado"}`);
  console.log(`[nexo-api] banco: ${config.databaseFile}`);
} catch (err) {
  console.error(err);
  process.exit(1);
}

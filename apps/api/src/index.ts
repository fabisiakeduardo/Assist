import { config, hasLlmKey } from "./config.js";
import { getDb } from "./db.js";
import { Store } from "./store.js";
import { seed } from "./seed.js";
import { TicketService } from "./services/ticketService.js";
import { HelpCenter } from "./services/helpCenter.js";
import { RealtimeHub } from "./realtime.js";
import { AgentRunner } from "./services/runner.js";
import { ScriptedEngine } from "./agent/scripted.js";
import { MastraEngine } from "./agent/mastra.js";
import { buildServer } from "./server.js";
import { registerRoutes } from "./routes.js";

// ─── bootstrap ───────────────────────────────────────────────────────────────

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

const app = await buildServer({ store });
registerRoutes(app, { store, tickets, help, runner, hub, engineKind });

try {
  await app.listen({ port: config.port, host: config.host });
  console.log(`[nexo-api] ouvindo em http://localhost:${config.port}`);
  console.log(`[nexo-api] engine do agent: ${engineKind}${engineKind === "mastra" ? ` (${config.llmModel})` : ""}`);
  console.log(`[nexo-api] banco: ${config.databaseFile}`);
} catch (err) {
  console.error(err);
  process.exit(1);
}

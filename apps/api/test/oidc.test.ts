import { describe, expect, it, beforeAll, afterAll, beforeEach } from "vitest";
import {
  createHash,
  generateKeyPairSync,
  sign as cryptoSign,
  type KeyObject,
} from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { DatabaseSync } from "node:sqlite";
import { openMemoryDb } from "../src/db.js";
import { Store } from "../src/store.js";
import { seed } from "../src/seed.js";
import { TicketService } from "../src/services/ticketService.js";
import { HelpCenter } from "../src/services/helpCenter.js";
import { RealtimeHub } from "../src/realtime.js";
import { AgentRunner } from "../src/services/runner.js";
import { ScriptedEngine } from "../src/agent/scripted.js";
import { buildServer, SESSION_COOKIE } from "../src/server.js";
import { registerRoutes } from "../src/routes.js";
import { OidcClient } from "../src/services/oidc.js";

// ─── fluxo OIDC completo contra um IdP fake (RSA de verdade) ─────────────────

const ISSUER = "https://idp.nexo.test";
const CLIENT_ID = "nexo-assist";
const REDIRECT_URI = "http://localhost:4100/api/auth/oidc/callback";

const idpKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const otherKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const idpJwk = {
  ...idpKeys.publicKey.export({ format: "jwk" }),
  kid: "idp-1",
  alg: "RS256",
  use: "sig",
};

const b64json = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");

function signJwt(claims: Record<string, unknown>, key: KeyObject): string {
  const data = `${b64json({ alg: "RS256", kid: "idp-1", typ: "JWT" })}.${b64json(claims)}`;
  return `${data}.${cryptoSign("RSA-SHA256", Buffer.from(data), key).toString("base64url")}`;
}

const json = (o: unknown) =>
  new Response(JSON.stringify(o), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

let app: FastifyInstance;
let store: Store;
let db: DatabaseSync;

// controles do IdP fake para cada cenário
let nextEmail = "ana.souza@nexo.com.br";
let nextNonceField: "right" | "wrong" = "right";
let signKey: KeyObject = idpKeys.privateKey;
let lastTokenParams: URLSearchParams | null = null;
let capturedNonce: string | null = null;

const fakeIdp = async (url: string, init?: RequestInit): Promise<Response> => {
  if (url === `${ISSUER}/.well-known/openid-configuration`) {
    return json({
      issuer: ISSUER,
      authorization_endpoint: `${ISSUER}/authorize`,
      token_endpoint: `${ISSUER}/token`,
      jwks_uri: `${ISSUER}/jwks.json`,
    });
  }
  if (url === `${ISSUER}/jwks.json`) return json({ keys: [idpJwk] });
  if (url === `${ISSUER}/token` && init?.method === "POST") {
    lastTokenParams = new URLSearchParams(init.body as string);
    const nonce = nextNonceField === "right" ? capturedNonce : "nonce-adulterado";
    const now = Math.floor(Date.now() / 1000);
    return json({
      access_token: "fake",
      token_type: "Bearer",
      id_token: signJwt(
        {
          iss: ISSUER,
          aud: CLIENT_ID,
          sub: "idp|ana",
          email: nextEmail,
          name: "Ana Souza",
          nonce,
          iat: now,
          exp: now + 300,
        },
        signKey,
      ),
    });
  }
  return new Response("not found", { status: 404 });
};

async function oidcLoginRedirect(): Promise<string> {
  const res = await app.inject({ method: "GET", url: "/api/auth/oidc/login" });
  expect(res.statusCode).toBe(302);
  const location = res.headers.location as string;
  // o IdP real não vê o nonce cru, mas o fake precisa dele p/ assinar o token;
  // lê o state recém-criado (o callback ainda não o consumiu)
  const state = new URL(location).searchParams.get("state");
  const row = db
    .prepare("SELECT nonce FROM oidc_states WHERE state = ?")
    .get(state!) as { nonce: string } | undefined;
  capturedNonce = row?.nonce ?? null;
  return location;
}

beforeAll(async () => {
  db = openMemoryDb();
  store = new Store(db);
  seed(store);
  const tickets = new TicketService(store, 0);
  const help = new HelpCenter(store);
  const hub = new RealtimeHub();
  const engine = new ScriptedEngine({ stepMs: 0, wordMs: 0 });
  const runner = new AgentRunner({ store, tickets, help }, engine, hub);
  const oidc = new OidcClient(
    {
      issuer: ISSUER,
      clientId: CLIENT_ID,
      redirectUri: REDIRECT_URI,
      scopes: "openid email profile",
      label: "Entrar com SSO corporativo",
    },
    fakeIdp,
  );
  app = await buildServer({ store });
  await app.register(
    async (api) => {
      registerRoutes(api, { store, tickets, help, runner, hub, engineKind: "scripted", oidc });
    },
    { prefix: "/api" },
  );
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  nextEmail = "ana.souza@nexo.com.br";
  nextNonceField = "right";
  signKey = idpKeys.privateKey;
  lastTokenParams = null;
});

describe("oidc sso", () => {
  it("/auth/providers expõe o provedor configurado", async () => {
    const res = await app.inject({ method: "GET", url: "/api/auth/providers" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      password: true,
      oidc: { label: "Entrar com SSO corporativo" },
    });
  });

  it("login → authorize com PKCE → callback cria sessão da Ana", async () => {
    const location = await oidcLoginRedirect();
    const auth = new URL(location);
    expect(auth.origin + auth.pathname).toBe(`${ISSUER}/authorize`);
    expect(auth.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(auth.searchParams.get("redirect_uri")).toBe(REDIRECT_URI);
    expect(auth.searchParams.get("code_challenge_method")).toBe("S256");
    const challenge = auth.searchParams.get("code_challenge");
    const state = auth.searchParams.get("state");
    expect(challenge).toBeTruthy();
    expect(state).toBeTruthy();

    const cb = await app.inject({
      method: "GET",
      url: `/api/auth/oidc/callback?code=authcode123&state=${state}`,
    });
    expect(cb.statusCode).toBe(302);
    expect(cb.headers.location).toBe("/");

    // PKCE ponta a ponta: verifier enviado ao /token bate com o challenge
    expect(lastTokenParams?.get("grant_type")).toBe("authorization_code");
    expect(lastTokenParams?.get("code")).toBe("authcode123");
    const verifier = lastTokenParams?.get("code_verifier");
    expect(verifier).toBeTruthy();
    expect(createHash("sha256").update(verifier!).digest("base64url")).toBe(challenge);

    // cookie de sessão criado → /me devolve a Ana
    const cookie = cb.cookies.find((c) => c.name === SESSION_COOKIE);
    expect(cookie).toBeTruthy();
    const me = await app.inject({
      method: "GET",
      url: "/api/me",
      headers: { cookie: `${SESSION_COOKIE}=${cookie!.value}` },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json().user.email).toBe("ana.souza@nexo.com.br");
    expect(me.json().user.role).toBe("employee");
  });

  it("state desconhecido → redirect /login?sso=state", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/auth/oidc/callback?code=x&state=state-que-nao-existe",
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe("/login?sso=state");
  });

  it("e-mail sem usuário local → redirect /login?sso=unknown_user", async () => {
    nextEmail = "externo@hacker.dev";
    const location = await oidcLoginRedirect();
    const state = new URL(location).searchParams.get("state")!;
    const cb = await app.inject({
      method: "GET",
      url: `/api/auth/oidc/callback?code=c&state=${state}`,
    });
    expect(cb.statusCode).toBe(302);
    expect(cb.headers.location).toBe("/login?sso=unknown_user");
    expect(cb.cookies.some((c) => c.name === SESSION_COOKIE)).toBe(false);
  });

  it("assinatura adulterada → redirect /login?sso=error", async () => {
    signKey = otherKeys.privateKey; // assina com chave que não está no JWKS
    const location = await oidcLoginRedirect();
    const state = new URL(location).searchParams.get("state")!;
    const cb = await app.inject({
      method: "GET",
      url: `/api/auth/oidc/callback?code=c&state=${state}`,
    });
    expect(cb.statusCode).toBe(302);
    expect(cb.headers.location).toBe("/login?sso=error");
  });

  it("nonce adulterado → redirect /login?sso=error", async () => {
    nextNonceField = "wrong";
    const location = await oidcLoginRedirect();
    const state = new URL(location).searchParams.get("state")!;
    const cb = await app.inject({
      method: "GET",
      url: `/api/auth/oidc/callback?code=c&state=${state}`,
    });
    expect(cb.statusCode).toBe(302);
    expect(cb.headers.location).toBe("/login?sso=error");
  });

  it("erro do IdP no callback → repassa o erro na query", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/auth/oidc/callback?error=access_denied",
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe("/login?sso=access_denied");
  });
});

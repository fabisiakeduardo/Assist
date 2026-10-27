import {
  createHash,
  createPublicKey,
  randomBytes,
  verify as cryptoVerify,
  type JsonWebKey,
  type KeyObject,
} from "node:crypto";

// ─── SSO via OIDC (Authorization Code + PKCE) ────────────────────────────────
// Cliente OIDC sem dependências: discovery via .well-known, troca do código
// com PKCE (S256) e validação do id_token com JWKS (RS256/384/512 e ES256/384/512
// via node:crypto). O `fetch` é injetável para testes com um IdP fake.
//
// O login OIDC autentica e mapeia o e-mail do IdP para um usuário local; a
// sessão da aplicação continua sendo o cookie nexo_sid (mesma fronteira de
// guards) — o OIDC substitui a verificação de senha, não a sessão.

export class OidcError extends Error {
  readonly statusCode = 401;
  constructor(message: string) {
    super(message);
    this.name = "OidcError";
  }
}

export interface OidcConfig {
  issuer: string;
  clientId: string;
  clientSecret?: string | undefined;
  redirectUri: string;
  scopes: string;
  /** Rótulo do botão na tela de login. */
  label: string;
}

export interface OidcMetadata {
  issuer?: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}

export interface OidcIdentity {
  email: string;
  name?: string;
  sub: string;
}

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

const b64url = (buf: Buffer) => buf.toString("base64url");

const newVerifier = () => b64url(randomBytes(32));
const challengeFor = (verifier: string) =>
  createHash("sha256").update(verifier).digest("base64url");

export const oidcPkce = { newVerifier, challengeFor };

export class OidcClient {
  private meta: OidcMetadata | null = null;
  private keys = new Map<string, JsonWebKey>();
  private keysFetchedAt = 0;

  constructor(
    readonly cfg: OidcConfig,
    private readonly http: FetchFn = (url, init) => fetch(url, init),
  ) {}

  /** Metadados do issuer (cacheados em memória). */
  async discover(): Promise<OidcMetadata> {
    if (this.meta) return this.meta;
    const base = this.cfg.issuer.replace(/\/+$/, "");
    const res = await this.http(`${base}/.well-known/openid-configuration`);
    if (!res.ok) throw new OidcError(`discovery do IdP falhou (HTTP ${res.status})`);
    const meta = (await res.json()) as OidcMetadata;
    if (!meta.authorization_endpoint || !meta.token_endpoint || !meta.jwks_uri) {
      throw new OidcError("metadata do IdP incompleto");
    }
    this.meta = meta;
    return meta;
  }

  /** URL para redirecionar o navegador ao IdP (authorize endpoint). */
  async authorizationUrl(state: string, nonce: string, verifier: string): Promise<string> {
    const meta = await this.discover();
    const url = new URL(meta.authorization_endpoint);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", this.cfg.clientId);
    url.searchParams.set("redirect_uri", this.cfg.redirectUri);
    url.searchParams.set("scope", this.cfg.scopes);
    url.searchParams.set("state", state);
    url.searchParams.set("nonce", nonce);
    url.searchParams.set("code_challenge", challengeFor(verifier));
    url.searchParams.set("code_challenge_method", "S256");
    return url.toString();
  }

  /** Troca o `code` do callback por tokens (form-urlencoded + PKCE verifier). */
  async exchangeCode(code: string, verifier: string): Promise<{ idToken: string }> {
    const meta = await this.discover();
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: this.cfg.redirectUri,
      client_id: this.cfg.clientId,
      code_verifier: verifier,
    });
    if (this.cfg.clientSecret) body.set("client_secret", this.cfg.clientSecret);
    const res = await this.http(meta.token_endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: body.toString(),
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      throw new OidcError(
        `troca do código falhou (HTTP ${res.status})${json.error ? `: ${json.error}` : ""}`,
      );
    }
    if (typeof json.id_token !== "string") throw new OidcError("resposta do IdP sem id_token");
    return { idToken: json.id_token };
  }

  private async jwkFor(kid: string | undefined): Promise<KeyObject> {
    if (Date.now() - this.keysFetchedAt > 10 * 60_000) this.keys.clear();
    if (!kid || !this.keys.has(kid)) {
      const meta = await this.discover();
      const res = await this.http(meta.jwks_uri);
      if (!res.ok) throw new OidcError(`JWKS do IdP falhou (HTTP ${res.status})`);
      const { keys } = (await res.json()) as { keys?: JsonWebKey[] };
      for (const k of keys ?? []) {
        if (typeof k.kid === "string") this.keys.set(k.kid, k);
      }
      this.keysFetchedAt = Date.now();
    }
    const jwk = kid ? this.keys.get(kid) : [...this.keys.values()][0];
    if (!jwk) throw new OidcError("chave do id_token não consta no JWKS");
    return createPublicKey({ key: jwk, format: "jwk" });
  }

  /** Verifica assinatura + claims (iss, aud, exp, nonce) e extrai a identidade. */
  async validateIdToken(token: string, expectedNonce: string): Promise<OidcIdentity> {
    const parts = token.split(".");
    if (parts.length !== 3) throw new OidcError("id_token malformado");
    const [h, p, s] = parts as [string, string, string];
    const header = JSON.parse(Buffer.from(h, "base64url").toString("utf8")) as {
      alg?: string;
      kid?: string;
    };
    const payload = JSON.parse(Buffer.from(p, "base64url").toString("utf8")) as Record<
      string,
      unknown
    >;

    const key = await this.jwkFor(header.kid);
    const data = Buffer.from(`${h}.${p}`);
    const sig = Buffer.from(s, "base64url");
    const alg = header.alg ?? "RS256";
    let ok: boolean;
    if (/^RS(256|384|512)$/.test(alg)) {
      ok = cryptoVerify(alg.replace("RS", "RSA-SHA"), data, key, sig);
    } else if (/^ES(256|384|512)$/.test(alg)) {
      ok = cryptoVerify(`SHA${alg.slice(2)}`, data, { key, dsaEncoding: "ieee-p1363" }, sig);
    } else {
      throw new OidcError(`algoritmo de assinatura não suportado: ${alg}`);
    }
    if (!ok) throw new OidcError("assinatura do id_token inválida");

    // claims (leeway de 60s para skew de relógio)
    const nowS = Math.floor(Date.now() / 1000);
    const issuer = this.cfg.issuer.replace(/\/+$/, "");
    const iss = typeof payload.iss === "string" ? payload.iss.replace(/\/+$/, "") : "";
    if (iss !== issuer) throw new OidcError("issuer do id_token não confere");
    const aud = payload.aud;
    const audOk = Array.isArray(aud) ? aud.includes(this.cfg.clientId) : aud === this.cfg.clientId;
    if (!audOk) throw new OidcError("audience do id_token não confere");
    if (typeof payload.exp !== "number" || payload.exp < nowS - 60) {
      throw new OidcError("id_token expirado");
    }
    if (payload.nonce !== expectedNonce) throw new OidcError("nonce do id_token não confere");

    const email = payload.email ?? payload.preferred_username;
    if (typeof email !== "string" || !email.includes("@")) {
      throw new OidcError("id_token sem e-mail do usuário");
    }
    const name = typeof payload.name === "string" ? payload.name : undefined;
    return {
      email: email.toLowerCase(),
      sub: typeof payload.sub === "string" ? payload.sub : email,
      ...(name !== undefined ? { name } : {}),
    };
  }
}

import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../auth";
import { ApiError } from "../api";
import {
  IconArrowRight,
  IconCheck,
  IconEye,
  IconEyeOff,
  IconLock,
  IconLogo,
  IconMail,
} from "../components/icons";

export function Login() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [remember, setRemember] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const u = await login(email.trim(), password);
      navigate(u.role === "analyst" ? "/console" : "/chat", { replace: true });
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 401
          ? "Esse e-mail não tem acesso ao service desk."
          : "Não foi possível entrar agora — tente de novo.",
      );
      setBusy(false);
    }
  }

  return (
    <div className="login">
      {/* showcase */}
      <section className="login-showcase">
        <div className="login-brand">
          <IconLogo size={24} />
          <span>Nexo Assist</span>
        </div>
        <div className="login-story">
          <div>
            <div className="login-eyebrow">Service desk de TI da Nexo</div>
            <h1 className="login-title">Seu problema de TI, resolvido em uma conversa.</h1>
            <p className="login-body">
              Descreva o que está acontecendo. O assistente consulta seus chamados, busca na
              central de ajuda e chama um analista quando precisa.
            </p>
          </div>
          <div className="login-preview" aria-hidden="true">
            <div className="pv-user">Meu notebook não conecta na VPN. Erro 809.</div>
            <div className="pv-agent">
              <div className="pv-who">
                <span className="pv-name">Nexo Assist</span>
                <span className="pv-steps">consultou seus chamados · criou um chamado</span>
              </div>
              <div className="pv-bubble">
                Pronto: abri o chamado com prioridade alta. Um analista fala com você em até 4 h
                úteis.
              </div>
              <div className="pv-ticket">
                <span className="dot" />
                <span className="num">INC-20517</span>
                <span className="meta">Rede e VPN · Alta · em até 4 h</span>
              </div>
            </div>
          </div>
        </div>
        <div className="login-stats">
          <div className="stat">
            <div className="num">8 s</div>
            <div className="label">primeira resposta, em média</div>
          </div>
          <div className="stat">
            <div className="num">72%</div>
            <div className="label">resolvidos sem fila</div>
          </div>
          <div className="stat">
            <div className="num">
              6 <span className="live" />
            </div>
            <div className="label">analistas online agora</div>
          </div>
        </div>
      </section>

      {/* formulário */}
      <section className="login-side">
        <div className="login-help">
          <span>Problema para entrar?</span>
          <a href="tel:4000">Ligue no ramal 4000</a>
        </div>
        <div className="login-center">
          <form className="login-form" onSubmit={onSubmit}>
            <h1>Entrar</h1>
            <p className="sub">Use seu e-mail corporativo e a senha da rede Nexo.</p>

            <div className="field">
              <div className="label-row">
                <label htmlFor="email">E-mail corporativo</label>
              </div>
              <div className="input-wrap">
                <IconMail size={16} />
                <input
                  id="email"
                  type="email"
                  autoComplete="username"
                  placeholder="ana.souza@nexo.com.br"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  autoFocus
                />
              </div>
            </div>

            <div className="field">
              <div className="label-row">
                <label htmlFor="password">Senha</label>
                <a className="hint-link" href="#" onClick={(e) => e.preventDefault()}>
                  Esqueci minha senha
                </a>
              </div>
              <div className="input-wrap">
                <IconLock size={16} />
                <input
                  id="password"
                  type={showPw ? "text" : "password"}
                  autoComplete="current-password"
                  placeholder="••••••••••"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                />
                <button
                  type="button"
                  className="pw-toggle"
                  onClick={() => setShowPw((s) => !s)}
                  aria-label={showPw ? "Ocultar senha" : "Mostrar senha"}
                >
                  {showPw ? <IconEyeOff size={16} /> : <IconEye size={16} />}
                </button>
              </div>
            </div>

            <label className="remember">
              <input
                type="checkbox"
                checked={remember}
                onChange={(e) => setRemember(e.target.checked)}
              />
              <span className="checkbox">
                <IconCheck size={12} />
              </span>
              Manter conectado neste computador
            </label>

            <button className="btn btn-primary btn-login" type="submit" disabled={busy}>
              {busy ? "Entrando…" : "Entrar"}
              {!busy && <IconArrowRight size={16} />}
            </button>

            {error && <div className="login-error">{error}</div>}

            <div className="login-note">
              Demo: <code>ana.souza@nexo.com.br</code> (funcionária) ·{" "}
              <code>rafael.lima@nexo.com.br</code> (analista) — qualquer senha.
            </div>
          </form>
        </div>
        <div className="login-footer">
          <span>© 2026 Nexo · Service desk de TI</span>
          <a href="#" onClick={(e) => e.preventDefault()}>
            Privacidade e uso de dados
          </a>
        </div>
      </section>
    </div>
  );
}

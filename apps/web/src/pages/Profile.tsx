import { useState } from "react";
import { useAuth } from "../auth";
import { TopBar } from "../components/Shell";
import { Avatar } from "../components/ui";

export function Profile() {
  const { user } = useAuth();
  const [sent, setSent] = useState(false);
  if (!user) return null;

  return (
    <div>
      <TopBar here="Meu perfil" />
      <div className="profile">
        <h2>Meu perfil</h2>
        <p className="sub">Seus dados de acesso ao service desk de TI.</p>
        <div className="profile-card">
          <div className="pc-head">
            <Avatar user={user} size={46} />
            <div className="who">
              <div className="name">{user.name}</div>
              <div className="email">{user.email}</div>
            </div>
          </div>
          <div className="profile-row">
            <div>
              <div className="k">Nome</div>
              <div className="v">{user.name}</div>
            </div>
          </div>
          <div className="profile-row">
            <div>
              <div className="k">E-mail corporativo</div>
              <div className="v">
                {user.email}
                <span className="sub-note">Gerenciado pela TI</span>
              </div>
            </div>
          </div>
          <div className="profile-row">
            <div>
              <div className="k">Time</div>
              <div className="v">{user.team || "—"}</div>
            </div>
          </div>
          <div className="profile-row">
            <div>
              <div className="k">Senha</div>
              <div className="v">
                Alterada há 42 dias
                <span className="sub-note">
                  {sent
                    ? `Link de redefinição enviado para ${user.email}.`
                    : `Enviaremos um link de redefinição para ${user.email}.`}
                </span>
              </div>
            </div>
            <button
              className="btn btn-ghost"
              onClick={() => setSent(true)}
              disabled={sent}
            >
              {sent ? "Link enviado" : "Redefinir senha"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

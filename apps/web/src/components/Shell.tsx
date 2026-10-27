import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { useAuth } from "../auth";
import { api } from "../api";
import { Avatar } from "./ui";
import { IconChat, IconLogo, IconLogout, IconUser } from "./icons";

// Shell do funcionário: sidebar 232 + conteúdo (chat / perfil)
export function EmployeeShell() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  if (!user) return null;

  return (
    <div className="shell">
      <aside className="side">
        <div className="logo">
          <IconLogo size={20} />
          <span>Nexo Assist</span>
        </div>
        <nav>
          <NavLink to="/chat" className={({ isActive }) => `nav-item ${isActive ? "active" : ""}`}>
            <IconChat size={16} />
            Atendimento
          </NavLink>
          <NavLink to="/perfil" className={({ isActive }) => `nav-item ${isActive ? "active" : ""}`}>
            <IconUser size={16} />
            Meu perfil
          </NavLink>
        </nav>
        <div className="spacer" />
        <div className="me">
          <Avatar user={user} size={34} />
          <div className="who">
            <div className="name">{user.name}</div>
            <div className="email">{user.email}</div>
          </div>
        </div>
        <button
          className="logout"
          onClick={async () => {
            await logout();
            navigate("/login");
          }}
        >
          <IconLogout size={16} />
          Sair
        </button>
      </aside>
      <Outlet />
    </div>
  );
}

export function TopBar({ here, right }: { here: string; right?: React.ReactNode }) {
  return (
    <header className="topbar">
      <div className="crumbs">
        <span className="root">Service desk de TI</span>
        <span className="sep">/</span>
        <h1 className="here">{here}</h1>
      </div>
      {right}
    </header>
  );
}

export function OnlinePill() {
  return (
    <span className="pill success">
      <span className="dot" />
      Assistente online
    </span>
  );
}

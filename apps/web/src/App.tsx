import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { useAuth } from "./auth";
import { EmployeeShell } from "./components/Shell";
import { EmployeeChat } from "./pages/EmployeeChat";
import { Profile } from "./pages/Profile";
import { Login } from "./pages/Login";
import { Console } from "./pages/Console";
import type { Role } from "./types";

function Guard({ role, children }: { role: Role; children: React.ReactNode }) {
  const { user, loading } = useAuth();
  const loc = useLocation();
  if (loading) return <div className="empty-state" style={{ height: "100%" }} />;
  if (!user) return <Navigate to="/login" state={{ from: loc.pathname }} replace />;
  if (user.role !== role) {
    return <Navigate to={user.role === "analyst" ? "/console" : "/chat"} replace />;
  }
  return <>{children}</>;
}

function Home() {
  const { user, loading } = useAuth();
  if (loading) return null;
  if (!user) return <Navigate to="/login" replace />;
  return <Navigate to={user.role === "analyst" ? "/console" : "/chat"} replace />;
}

export function App() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/login" element={<Login />} />
      <Route
        element={
          <Guard role="employee">
            <EmployeeShell />
          </Guard>
        }
      >
        <Route path="/chat" element={<EmployeeChat />} />
        <Route path="/perfil" element={<Profile />} />
      </Route>
      <Route
        path="/console"
        element={
          <Guard role="analyst">
            <Console />
          </Guard>
        }
      />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

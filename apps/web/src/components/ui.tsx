import type { PublicUser } from "../types";

export function Avatar({
  user,
  size = 34,
  online,
}: {
  user: Pick<PublicUser, "name" | "avatarBg" | "avatarFg">;
  size?: number;
  online?: boolean;
}) {
  const initials = user.name
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");
  return (
    <div
      className="avatar"
      style={{
        width: size,
        height: size,
        background: user.avatarBg,
        color: user.avatarFg,
        fontSize: size * 0.38,
      }}
    >
      {initials}
      {online && <span className="online-dot" />}
    </div>
  );
}

export function StatusDot({ color }: { color: string }) {
  return (
    <span
      style={{
        width: 7,
        height: 7,
        borderRadius: 999,
        background: color,
        display: "inline-block",
        flexShrink: 0,
      }}
    />
  );
}

export function fmtTime(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function fmtDayMonth(iso: string): string {
  const MONTHS = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];
  const d = new Date(iso);
  return `${String(d.getDate()).padStart(2, "0")} ${MONTHS[d.getMonth()]}`;
}

export function fmtAgo(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  if (diffMs < 45_000) return "agora";
  const mins = Math.round(diffMs / 60_000);
  if (mins < 60) return `há ${mins} min`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `há ${hours} h`;
  const days = Math.round(hours / 24);
  if (days < 30) return `há ${days} ${days === 1 ? "dia" : "dias"}`;
  const months = Math.round(days / 30);
  return `há ${months} ${months === 1 ? "mês" : "meses"}`;
}

/** cor do ponto de status do chamado (statusLabel → tom) */
export function statusTone(status: string): string {
  switch (status) {
    case "aberto":
      return "var(--primary)";
    case "em_andamento":
      return "var(--primary)";
    case "aguardando_analista":
    case "aguardando_solicitante":
      return "var(--warning)";
    case "aprovado":
    case "resolvido":
      return "var(--success)";
    case "cancelado":
      return "#1b243140";
    default:
      return "var(--ink-3)";
  }
}

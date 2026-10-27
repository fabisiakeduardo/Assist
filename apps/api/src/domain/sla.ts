import type { TicketPriority } from "./types.js";

// ─── Prazos do service desk (Anexo A) ────────────────────────────────────────
// Crítica: 1 hora (correto, plantão 24h — conta horas corridas)
// Alta:    4 horas úteis
// Média:   3 dias úteis
// Baixa:   5 dias úteis
//
// Horário útil do service desk: seg–sex, 08:00–18:00.

const BUSINESS_START_HOUR = 8;
const BUSINESS_END_HOUR = 18;
const BUSINESS_HOURS_PER_DAY = BUSINESS_END_HOUR - BUSINESS_START_HOUR;

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function isBusinessDay(d: Date): boolean {
  const day = d.getDay();
  return day >= 1 && day <= 5;
}

/** Avança `date` até o próximo instante dentro do horário útil. */
function nextBusinessStart(date: Date): Date {
  const d = new Date(date.getTime());
  // Fim de semana → próxima segunda 08:00
  while (!isBusinessDay(d)) {
    d.setDate(d.getDate() + 1);
    d.setHours(BUSINESS_START_HOUR, 0, 0, 0);
  }
  if (d.getHours() < BUSINESS_START_HOUR) {
    d.setHours(BUSINESS_START_HOUR, 0, 0, 0);
  } else if (d.getHours() >= BUSINESS_END_HOUR) {
    d.setDate(d.getDate() + 1);
    d.setHours(BUSINESS_START_HOUR, 0, 0, 0);
    return nextBusinessStart(d);
  }
  return d;
}

/** Soma `hours` horas úteis a partir de `from`. */
export function addBusinessHours(from: Date, hours: number): Date {
  let cursor = nextBusinessStart(from);
  let remainingMs = hours * HOUR;
  while (remainingMs > 0) {
    const endOfDay = new Date(cursor.getTime());
    endOfDay.setHours(BUSINESS_END_HOUR, 0, 0, 0);
    const available = endOfDay.getTime() - cursor.getTime();
    if (remainingMs <= available) {
      return new Date(cursor.getTime() + remainingMs);
    }
    remainingMs -= available;
    cursor = nextBusinessStart(new Date(cursor.getTime() + DAY));
  }
  return cursor;
}

/** Soma `days` dias úteis a partir de `from` (fim de semana não conta). */
export function addBusinessDays(from: Date, days: number): Date {
  let d = new Date(from.getTime());
  let added = 0;
  while (added < days) {
    d = new Date(d.getTime() + DAY);
    if (isBusinessDay(d)) added++;
  }
  return d;
}

/** Prazo de próxima resposta/atualização para um chamado aberto em `from`. */
export function computeDueAt(priority: TicketPriority, from: Date): Date {
  switch (priority) {
    case "critica":
      return new Date(from.getTime() + 1 * HOUR);
    case "alta":
      return addBusinessHours(from, 4);
    case "media":
      return addBusinessDays(from, 3);
    case "baixa":
      return addBusinessDays(from, 5);
  }
}

/** Descrição curta do prazo, ex.: "em até 4 h úteis". */
export function slaLabel(priority: TicketPriority): string {
  switch (priority) {
    case "critica":
      return "em até 1 hora";
    case "alta":
      return "em até 4 h úteis";
    case "media":
      return "em até 3 dias úteis";
    case "baixa":
      return "em até 5 dias úteis";
  }
}

export function isOverdue(dueAt: string, now = new Date()): boolean {
  return new Date(dueAt).getTime() < now.getTime();
}

// ─── Formatação de datas em pt-BR ───────────────────────────────────────────

const MONTHS = [
  "jan",
  "fev",
  "mar",
  "abr",
  "mai",
  "jun",
  "jul",
  "ago",
  "set",
  "out",
  "nov",
  "dez",
];

/** "16 out" */
export function fmtDayMonth(iso: string | Date): string {
  const d = typeof iso === "string" ? new Date(iso) : iso;
  return `${String(d.getDate()).padStart(2, "0")} ${MONTHS[d.getMonth()]}`;
}

/** "16 out, 14:20" */
export function fmtDayMonthTime(iso: string | Date): string {
  const d = typeof iso === "string" ? new Date(iso) : iso;
  return `${fmtDayMonth(d)}, ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** "14:05" */
export function fmtTime(iso: string | Date): string {
  const d = typeof iso === "string" ? new Date(iso) : iso;
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** "há 5 dias", "há 3 h", "agora" — relativo a `now`. */
export function fmtAgo(iso: string | Date, now = new Date()): string {
  const d = typeof iso === "string" ? new Date(iso) : iso;
  const diffMs = now.getTime() - d.getTime();
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

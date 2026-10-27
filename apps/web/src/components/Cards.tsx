import { useEffect, useState } from "react";
import { api } from "../api";
import type { Ticket, TicketDraft } from "../types";
import { fmtDayMonth, fmtTime, statusTone } from "./ui";

// ─── botões de opção numerados ───────────────────────────────────────────────

export function OptionButtons({
  options,
  onPick,
  disabled,
}: {
  options: string[];
  onPick: (label: string) => void;
  disabled?: boolean;
}) {
  return (
    <div className="options-row" role="group" aria-label="Opções rápidas">
      {options.map((o, i) => (
        <button
          key={o}
          className="opt-btn"
          disabled={disabled}
          onClick={() => onPick(o)}
          aria-keyshortcuts={String(i + 1)}
        >
          <span className="key">{i + 1}</span>
          {o}
        </button>
      ))}
    </div>
  );
}

// ─── seletor de chamados ─────────────────────────────────────────────────────

export function TicketSelector({
  ticketIds,
  onPick,
  disabled,
}: {
  ticketIds: string[];
  onPick: (ticketId: string) => void;
  disabled?: boolean;
}) {
  const [tickets, setTickets] = useState<Ticket[]>([]);
  useEffect(() => {
    api
      .tickets()
      .then((r) => setTickets(r.tickets))
      .catch(() => setTickets([]));
  }, [ticketIds.join(",")]);

  const byId = new Map(tickets.map((t) => [t.id, t]));
  return (
    <div className="selector-list" role="list">
      {ticketIds.map((id) => {
        const t = byId.get(id);
        return (
          <button
            key={id}
            className="selector-item"
            disabled={disabled}
            onClick={() => onPick(t ? `${id} · ${t.title}` : id)}
          >
            <span className="num">{id}</span>
            <span className="t">
              <span className="title">{t?.title ?? "carregando…"}</span>
              {t && (
                <span className="meta">
                  <span className="s-dot" style={{ background: statusTone(t.status) }} />
                  {t.statusLabel} · {fmtDayMonth(t.createdAt)}
                </span>
              )}
            </span>
          </button>
        );
      })}
    </div>
  );
}

// ─── card de chamado (resumo) ────────────────────────────────────────────────

export function TicketCard({ ticketId }: { ticketId: string }) {
  const [ticket, setTicket] = useState<Ticket | null>(null);
  useEffect(() => {
    let live = true;
    api
      .ticket(ticketId)
      .then((r) => live && setTicket(r.ticket))
      .catch(() => live && setTicket(null));
    return () => {
      live = false;
    };
  }, [ticketId]);

  if (!ticket) {
    return (
      <div className="ticket-card">
        <div className="tc-head">
          <span className="num">{ticketId}</span>
        </div>
      </div>
    );
  }
  return (
    <div className="ticket-card">
      <div className="tc-head">
        <span className="num">{ticket.id}</span>
        <span className={`pill ${pillFor(ticket.status, ticket.overdue)}`}>
          <span className="dot" />
          {ticket.statusLabel}
        </span>
      </div>
      <div className="tc-title">{ticket.title}</div>
      <div className="tc-desc">{ticket.description}</div>
      <div className="tc-fields">
        <div className="tc-field">
          <div className="k">Categoria</div>
          <div className="v">
            {ticket.category}
            {ticket.subcategory ? ` › ${ticket.subcategory}` : ""}
          </div>
        </div>
        <div className="tc-field">
          <div className="k">Prioridade</div>
          <div className="v">
            <span
              style={{
                width: 6,
                height: 6,
                borderRadius: 999,
                background: priorityColor(ticket.priority),
                display: "inline-block",
              }}
            />
            {ticket.priorityLabel}
            <span className={`due ${ticket.overdue ? "overdue" : ""}`}>
              · {ticket.overdue ? "prazo vencido" : `resposta até ${fmtTime(ticket.dueAt)}`}
            </span>
          </div>
        </div>
        <div className="tc-field">
          <div className="k">Aberto em</div>
          <div className="v">
            {fmtDayMonth(ticket.createdAt)}, {fmtTime(ticket.createdAt)}
          </div>
        </div>
        <div className="tc-field">
          <div className="k">Última atualização</div>
          <div className="v">
            {ticket.ago}
            {ticket.overdue && <span className="due overdue">· prazo vencido</span>}
          </div>
        </div>
      </div>
    </div>
  );
}

function priorityColor(p: Ticket["priority"]): string {
  switch (p) {
    case "critica":
      return "var(--danger)";
    case "alta":
      return "var(--warning)";
    case "media":
      return "var(--primary)";
    default:
      return "var(--ink-3)";
  }
}

function pillFor(status: string, overdue: boolean): string {
  if (overdue) return "danger";
  switch (status) {
    case "resolvido":
    case "aprovado":
      return "success";
    case "aguardando_analista":
    case "aguardando_solicitante":
      return "warning";
    case "cancelado":
      return "neutral";
    default:
      return "primary";
  }
}

// ─── card de rascunho ────────────────────────────────────────────────────────

export function DraftCard({
  draft,
  onConfirm,
  onCancel,
  onEdit,
  busy,
}: {
  draft: TicketDraft;
  onConfirm: () => void;
  onCancel: () => void;
  onEdit?: () => void;
  busy?: boolean;
}) {
  return (
    <div className="draft-card">
      <div className="dc-body">
        <div className="dc-eyebrow">
          <span>{draft.kind === "REQ" ? "Nova requisição" : "Novo chamado"}</span>
          <span className="sep-dot" />
          <span>Rascunho {draft.id.slice(0, 5).toUpperCase()}</span>
          <span className="dc-state">
            <span className="dot" />
            Aguardando confirmação
          </span>
        </div>
        <div className="dc-title">{draft.title}</div>
        <div className="dc-desc">{draft.description}</div>
      </div>
      <div className="dc-fields">
        <div className="tc-field">
          <div className="k">Categoria</div>
          <div className="v">{draft.category}</div>
        </div>
        <div className="tc-field">
          <div className="k">Prioridade</div>
          <div className="v">
            <span
              style={{
                width: 6,
                height: 6,
                borderRadius: 999,
                background: priorityColor(draft.priority),
                display: "inline-block",
              }}
            />
            {priorityLabel(draft.priority)}
            <span className="due">· resposta até {fmtTime(draft.dueAt)}</span>
          </div>
        </div>
        <div className="tc-field">
          <div className="k">Afetados</div>
          <div className="v">{draft.affected}</div>
        </div>
      </div>
      <div className="dc-actions">
        <button className="btn btn-primary" onClick={onConfirm} disabled={busy}>
          Confirmar
          <span className="kbd">⌘↵</span>
        </button>
        <button className="btn btn-quiet" onClick={onEdit} disabled={busy} title="Descreva a correção na caixa de mensagem">
          Editar
        </button>
        <button className="btn btn-quiet" onClick={onCancel} disabled={busy}>
          Cancelar
        </button>
        <span className="gap" />
      </div>
    </div>
  );
}

function priorityLabel(p: Ticket["priority"]): string {
  return { critica: "Crítica", alta: "Alta", media: "Média", baixa: "Baixa" }[p];
}

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api";
import { useAuth } from "../auth";
import type {
  ConsoleConversation,
  Conversation,
  Message,
  PublicUser,
  RealtimeEvent,
  Ticket,
} from "../types";
import { Avatar, fmtAgo, fmtDayMonth, fmtTime, statusTone } from "../components/ui";
import { StepsLine } from "../components/StepsLine";
import {
  IconChat,
  IconChecks,
  IconChevronR,
  IconDots,
  IconLogo,
  IconLogout,
  IconPause,
  IconRotate,
  IconSearch,
  IconSend,
  IconTicket,
  IconUserPlus,
} from "../components/icons";

type Filter = "all" | "for_you" | "with_agent" | "mine";

export function Console() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [filter, setFilter] = useState<Filter>("all");
  const [q, setQ] = useState("");
  const [items, setItems] = useState<ConsoleConversation[]>([]);
  const [counts, setCounts] = useState({ for_you: 0, with_agent: 0, mine: 0 });
  const [activeId, setActiveId] = useState<string | null>(null);
  const [panelOpen, setPanelOpen] = useState(true);

  const loadList = useCallback(async () => {
    const r = await api.consoleConversations(filter === "all" ? undefined : filter, q || undefined);
    setItems(r.items);
    setCounts(r.counts);
  }, [filter, q]);

  useEffect(() => {
    void loadList();
  }, [loadList]);

  // SSE global: qualquer mudança recarrega a lista
  useEffect(() => {
    const es = new EventSource(api.consoleStreamUrl());
    let t: ReturnType<typeof setTimeout> | null = null;
    es.onmessage = (ev) => {
      const e = JSON.parse(ev.data) as RealtimeEvent;
      if (e.type === "conversations_changed") {
        if (t) clearTimeout(t);
        t = setTimeout(() => void loadList(), 180);
      }
    };
    return () => {
      if (t) clearTimeout(t);
      es.close();
    };
  }, [loadList]);

  const unreadTotal = items.reduce((s, c) => s + (c.unreadForAnalyst || 0), 0);
  const active = items.find((c) => c.id === activeId) ?? null;

  return (
    <div className={`console ${panelOpen && active ? "with-panel" : ""}`}>
      {/* rail */}
      <aside className="rail">
        <div className="logo">
          <IconLogo size={22} />
        </div>
        <button className="rail-btn active" title="Conversas">
          <IconChat size={19} />
          {unreadTotal > 0 && <span className="badge">{unreadTotal}</span>}
        </button>
        <div className="spacer" />
        {user && <Avatar user={user} size={36} online />}
        <button
          className="rail-btn"
          title="Sair"
          onClick={async () => {
            await logout();
            navigate("/login");
          }}
        >
          <IconLogout size={17} />
        </button>
      </aside>

      {/* lista */}
      <section className="chat-list">
        <div className="cl-head">
          <div className="cl-title-row">
            <h1>Conversas</h1>
            <span className="pill success">
              <span className="dot" />
              Disponível
            </span>
          </div>
          <div className="cl-search">
            <IconSearch size={15} />
            <input
              placeholder="Pesquisar conversa ou chamado"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>
          <div className="cl-filters">
            <FilterPill label="Todas" active={filter === "all"} onClick={() => setFilter("all")} />
            <FilterPill
              label="Para você"
              count={counts.for_you}
              active={filter === "for_you"}
              onClick={() => setFilter("for_you")}
            />
            <FilterPill
              label="Com o agent"
              count={counts.with_agent}
              active={filter === "with_agent"}
              onClick={() => setFilter("with_agent")}
            />
            <FilterPill
              label="Minhas"
              count={counts.mine}
              active={filter === "mine"}
              onClick={() => setFilter("mine")}
            />
          </div>
        </div>
        <div className="cl-items scroll-thin">
          {items.map((c) => (
            <ConversationItem
              key={c.id}
              c={c}
              me={user}
              active={c.id === activeId}
              onClick={() => setActiveId(c.id)}
            />
          ))}
          {items.length === 0 && (
            <div className="empty-state" style={{ padding: 24 }}>
              <span className="small">Nenhuma conversa neste filtro.</span>
            </div>
          )}
        </div>
      </section>

      {/* conversa ativa */}
      {active ? (
        <ActiveConversation
          key={active.id}
          item={active}
          me={user!}
          onChanged={loadList}
          panelOpen={panelOpen}
          onTogglePanel={() => setPanelOpen((p) => !p)}
        />
      ) : (
        <section className="conv">
          <div className="empty-state">
            <IconChat size={28} />
            <span className="big">Escolha uma conversa</span>
            <span className="small">As transferências do Nexo Assist aparecem em "Para você".</span>
          </div>
        </section>
      )}

      {/* painel de chamados */}
      {panelOpen && active && <TicketPanel key={`tp-${active.id}`} conv={active} />}
    </div>
  );
}

function FilterPill({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count?: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button className={`filter-pill ${active ? "active" : ""}`} onClick={onClick}>
      {label}
      {count !== undefined && count > 0 && <span className="count">{count}</span>}
    </button>
  );
}

function tagFor(c: ConsoleConversation, me?: PublicUser | null) {
  if (c.status === "waiting_analyst") {
    return { cls: "danger", dot: "var(--danger)", label: `Transferida${c.ticketId ? ` · ${c.ticketId}` : ""}` };
  }
  if (c.status === "with_analyst") {
    const mine = me && c.analystId === me.id;
    return {
      cls: mine ? "warning" : "muted",
      dot: "var(--warning)",
      label: mine ? "Você está atendendo" : "Com um analista",
    };
  }
  if (c.status === "with_agent") {
    return { cls: "muted", dot: "var(--success)", label: "Agent atendendo" };
  }
  return { cls: "muted", dot: "#1b243155", label: "Encerrada" };
}

function ConversationItem({
  c,
  me,
  active,
  onClick,
}: {
  c: ConsoleConversation;
  me?: PublicUser | null;
  active: boolean;
  onClick: () => void;
}) {
  const tag = tagFor(c, me);
  const last = c.lastMessage;
  const hot = c.status === "waiting_analyst" || c.unreadForAnalyst > 0;
  return (
    <button className={`cl-item ${active ? "active" : ""}`} onClick={onClick}>
      <Avatar user={c.employee} size={46} online={c.status !== "closed"} />
      <div className="text">
        <div className="top">
          <span className="name">{c.employee.name}</span>
          <span className={`time ${hot ? "hot" : ""}`}>
            {last ? fmtTime(last.createdAt) : fmtDayMonth(c.lastMessageAt)}
          </span>
        </div>
        <div className="bottom">
          <span className="last">
            {last ? `${last.sender === "agent" ? "Nexo: " : last.sender === "analyst" ? "Você: " : ""}${last.text}` : "sem mensagens"}
          </span>
          {c.unreadForAnalyst > 0 && <span className="unread">{c.unreadForAnalyst}</span>}
        </div>
        <div className={`tag ${tag.cls}`}>
          <span className="dot" style={{ background: tag.dot }} />
          {tag.label}
        </div>
      </div>
    </button>
  );
}

// ─── conversa ativa ──────────────────────────────────────────────────────────

function ActiveConversation({
  item,
  me,
  onChanged,
  panelOpen,
  onTogglePanel,
}: {
  item: ConsoleConversation;
  me: PublicUser;
  onChanged: () => void;
  panelOpen: boolean;
  onTogglePanel: () => void;
}) {
  const [conv, setConv] = useState<Conversation>(item);
  const [employee, setEmployee] = useState<PublicUser>(item.employee);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const seen = useRef(new Set<string>());

  const mine = conv.status === "with_analyst" && conv.analystId === me.id;

  useEffect(() => {
    let live = true;
    seen.current = new Set();
    api.conversation(item.id).then((d) => {
      if (!live) return;
      setConv(d.conversation);
      setMessages(d.messages);
      if (d.employee) setEmployee(d.employee);
      d.messages.forEach((m) => seen.current.add(m.id));
    });
    const es = new EventSource(api.streamUrl(item.id));
    es.onmessage = (ev) => {
      const e = JSON.parse(ev.data) as RealtimeEvent;
      if (e.type === "message") {
        if (!seen.current.has(e.message.id)) {
          seen.current.add(e.message.id);
          setMessages((ms) => [...ms, e.message]);
        }
      } else if (e.type === "conversation") {
        api.conversation(item.id).then((d) => live && setConv(d.conversation));
      }
    };
    return () => {
      live = false;
      es.close();
    };
  }, [item.id]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  async function act(fn: () => Promise<{ conversation: Conversation }>) {
    if (busy) return;
    setBusy(true);
    try {
      const r = await fn();
      setConv(r.conversation);
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  async function send() {
    const t = input.trim();
    if (!t || busy) return;
    setBusy(true);
    setInput("");
    try {
      const r = await api.sendMessage(conv.id, t);
      if (!seen.current.has(r.message.id)) {
        seen.current.add(r.message.id);
        setMessages((ms) => [...ms, r.message]);
      }
    } finally {
      setBusy(false);
    }
  }

  const modePill =
    conv.status === "waiting_analyst" ? (
      <span className="pill warning">
        <IconPause size={13} /> Aguardando atendente
      </span>
    ) : conv.status === "with_analyst" ? (
      mine ? (
        <span className="pill success">Você está atendendo</span>
      ) : (
        <span className="pill neutral">Com outro analista</span>
      )
    ) : conv.status === "with_agent" ? (
      <span className="pill primary">Agent atendendo</span>
    ) : (
      <span className="pill neutral">Encerrada</span>
    );

  return (
    <section className="conv">
      <header className="conv-head">
        <Avatar user={employee} size={40} online={conv.status !== "closed"} />
        <div className="who">
          <div className="name">{employee.name}</div>
          <div className="meta">
            online · {employee.team || "—"}
            {conv.ticketId ? ` · ${conv.ticketId}` : ""}
          </div>
        </div>
        {modePill}
        <div className="head-actions">
          {mine && (
            <>
              <button className="btn btn-ghost" disabled={busy} onClick={() => void act(() => api.release(conv.id))}>
                <IconRotate size={15} /> Devolver ao agent
              </button>
              <button className="btn btn-danger-soft" disabled={busy} onClick={() => void act(() => api.close(conv.id))}>
                Encerrar atendimento
              </button>
            </>
          )}
          <button className="icon-btn" title={panelOpen ? "Fechar painel" : "Abrir painel"} onClick={onTogglePanel}>
            <IconTicket size={18} />
          </button>
          <button className="icon-btn" title="Mais opções">
            <IconDots size={18} />
          </button>
        </div>
      </header>

      <div className="conv-msgs scroll-thin" ref={scrollRef}>
        <span className="day-pill">Hoje</span>
        {messages.map((m) => (
          <ConsoleMessage key={m.id} m={m} analystName={me.name} />
        ))}
      </div>

      {conv.status === "waiting_analyst" && (
        <div className="takeover">
          <div className="row">
            <span className="icon-wrap">
              <IconUserPlus size={17} />
            </span>
            <div className="t">
              <div className="title">{employee.name.split(" ")[0]} espera um atendente</div>
              <div className="body">
                Agent pausado{conv.handoffAt ? ` · desde ${fmtTime(conv.handoffAt)}` : ""}
              </div>
            </div>
            <button className="btn btn-primary" disabled={busy} onClick={() => void act(() => api.assume(conv.id))}>
              <IconUserPlus size={16} /> Assumir atendimento
            </button>
          </div>
          <div className="composer-locked">Assuma o atendimento para responder</div>
        </div>
      )}
      {conv.status === "with_agent" && (
        <div className="takeover">
          <div className="row">
            <span className="icon-wrap ok">
              <IconChecks size={17} />
            </span>
            <div className="t">
              <div className="title">O Nexo Assist está atendendo</div>
              <div className="body">Assuma se quiser responder manualmente</div>
            </div>
            <button className="btn btn-ghost" disabled={busy} onClick={() => void act(() => api.assume(conv.id))}>
              Assumir atendimento
            </button>
          </div>
        </div>
      )}
      {conv.status === "with_analyst" && !mine && (
        <div className="takeover">
          <div className="composer-locked">Outro analista está atendendo esta conversa</div>
        </div>
      )}
      {conv.status === "closed" && (
        <div className="takeover">
          <div className="composer-locked">Conversa encerrada</div>
        </div>
      )}
      {mine && (
        <div className="takeover" style={{ paddingTop: 8 }}>
          <form
            className="composer"
            onSubmit={(e) => {
              e.preventDefault();
              void send();
            }}
          >
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={`Responder para ${employee.name.split(" ")[0]}…`}
              aria-label="Responder como analista"
            />
            <button className="btn btn-primary send" type="submit" disabled={busy || !input.trim()}>
              <IconSend size={14} /> Enviar
            </button>
          </form>
        </div>
      )}
    </section>
  );
}

function ConsoleMessage({ m, analystName }: { m: Message; analystName: string }) {
  if (m.sender === "system") {
    return (
      <div className="msg system-msg">
        <span className="line" />
        <span className="sys-label">
          {m.text} · {fmtTime(m.createdAt)}
        </span>
        <span className="line" />
      </div>
    );
  }
  if (m.sender === "user") {
    return (
      <div className="cm client">
        <div className="bubble">{m.text}</div>
        <div className="m-meta">{fmtTime(m.createdAt)}</div>
      </div>
    );
  }
  if (m.sender === "agent") {
    return (
      <div className="cm agent-msg">
        <div className="sender-row">
          <span className="sname">Nexo Assist</span>
          <span className="ia-tag">IA</span>
        </div>
        {m.steps && m.steps.length > 0 ? (
          <div className="console-steps">
            <StepsLine steps={m.steps} who="" />
          </div>
        ) : null}
        <div className="bubble">{m.text}</div>
        <div className="m-meta">{fmtTime(m.createdAt)}</div>
      </div>
    );
  }
  return (
    <div className="cm analyst-msg">
      <div className="sender-row">
        <span className="sname" style={{ color: "var(--ink-3)" }}>{analystName} · Suporte</span>
      </div>
      <div className="bubble">{m.text}</div>
      <div className="m-meta">{fmtTime(m.createdAt)}</div>
    </div>
  );
}

// ─── painel de chamados do funcionário ───────────────────────────────────────

function TicketPanel({ conv }: { conv: ConsoleConversation }) {
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [counts, setCounts] = useState({ open: 0, closed: 0 });

  useEffect(() => {
    api
      .userTickets(conv.userId)
      .then((r) => {
        setTickets(r.tickets);
        setCounts({ open: r.openCount, closed: r.closedCount });
      })
      .catch(() => setTickets([]));
  }, [conv.userId]);

  const current = useMemo(
    () => tickets.find((t) => t.id === conv.ticketId) ?? null,
    [tickets, conv.ticketId],
  );
  const others = tickets.filter((t) => t.id !== conv.ticketId);

  return (
    <aside className="ticket-panel">
      <div className="tp-head">
        <div>
          <div className="title">Chamados d{conv.employee.name.endsWith("a") ? "a" : "o"} {conv.employee.name.split(" ")[0]}</div>
          <div className="meta">
            {counts.open} abertos · {counts.closed} encerrados
          </div>
        </div>
      </div>
      <div className="tp-body scroll-thin">
        {conv.handoffSummary && (
          <div className="handoff-box">
            <div className="h-title">Resumo da transferência</div>
            {conv.handoffSummary}
          </div>
        )}
        <div className="tp-label">Desta conversa</div>
        {current ? (
          <div className="current-ticket">
            <div className="row">
              <span className="num">{current.id}</span>
              <span className={`pill ${current.overdue ? "danger" : "warning"}`}>
                <span className="dot" />
                {current.statusLabel}
              </span>
            </div>
            <div className="title">{current.title}</div>
            <div className="meta">
              {current.category} · prioridade {current.priorityLabel.toLowerCase()}
            </div>
            <div className="event">
              <IconTicket size={15} />
              <span className="t">
                {conv.status === "with_analyst"
                  ? "Em atendimento por analista"
                  : conv.status === "waiting_analyst"
                    ? "Transferido para um analista"
                    : "Atualizado"}
              </span>
              <span className="time">{fmtAgo(current.updatedAt)}</span>
            </div>
          </div>
        ) : (
          <div className="current-ticket">
            <div className="meta">Nenhum chamado vinculado a esta conversa.</div>
          </div>
        )}
        {others.length > 0 && (
          <>
            <div className="tp-label">Outros chamados</div>
            {others.map((t) => (
              <div key={t.id} className="ticket-row">
                <span className="dot" style={{ background: statusTone(t.status) }} />
                <span className="t">
                  <span className="title">{t.title}</span>
                  <span className="meta">
                    {t.id} · {t.statusLabel}
                  </span>
                </span>
                <IconChevronR size={16} />
              </div>
            ))}
          </>
        )}
      </div>
      <div className="tp-foot">
        <button className="tp-all">
          Ver todos os chamados d{conv.employee.name.endsWith("a") ? "a" : "o"} {conv.employee.name.split(" ")[0]}
          <IconChevronR size={14} />
        </button>
      </div>
    </aside>
  );
}

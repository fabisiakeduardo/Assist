import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError } from "../api";
import { useAuth } from "../auth";
import type {
  AgentStep,
  CardPayload,
  Conversation,
  Message,
  RealtimeEvent,
  TicketDraft,
} from "../types";
import { DraftCard, OptionButtons, TicketCard, TicketSelector } from "../components/Cards";
import { OnlinePill, TopBar } from "../components/Shell";
import { StepsLine } from "../components/StepsLine";
import { IconInfo, IconSend } from "../components/icons";
import { fmtTime } from "../components/ui";

interface Streaming {
  id: string;
  steps: AgentStep[];
  text: string;
}

export function EmployeeChat() {
  const { user, usage, setUsage } = useAuth();
  const [conv, setConv] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState<TicketDraft | null>(null);
  const [stream, setStream] = useState<Streaming | null>(null);
  const [sending, setSending] = useState(false);
  const [draftBusy, setDraftBusy] = useState(false);
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const seen = useRef(new Set<string>());

  // ── carrega conversa atual + mensagens ────────────────────────────────────
  useEffect(() => {
    let live = true;
    (async () => {
      const { conversation } = await api.currentConversation();
      if (!live) return;
      setConv(conversation);
      const detail = await api.conversation(conversation.id);
      if (!live) return;
      setConv(detail.conversation);
      setMessages(detail.messages);
      setDraft(detail.pendingDraft);
      if (detail.usage) setUsage(detail.usage);
      detail.messages.forEach((m) => seen.current.add(m.id));
    })().catch((e) => setError(e.message));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── SSE: eventos da conversa ──────────────────────────────────────────────
  useEffect(() => {
    if (!conv) return;
    const es = new EventSource(api.streamUrl(conv.id));
    es.onmessage = (ev) => {
      const e = JSON.parse(ev.data) as RealtimeEvent;
      switch (e.type) {
        case "agent_start":
          setStream({ id: e.messageId, steps: [], text: "" });
          break;
        case "agent_step":
          setStream((s) =>
            s && s.id === e.messageId ? { ...s, steps: [...s.steps, e.step] } : s,
          );
          break;
        case "agent_delta":
          setStream((s) => (s && s.id === e.messageId ? { ...s, text: s.text + e.delta } : s));
          break;
        case "agent_end":
          break; // a mensagem final chega pelo evento "message"
        case "message":
          if (!seen.current.has(e.message.id)) {
            seen.current.add(e.message.id);
            setMessages((ms) => [...ms, e.message]);
          }
          setStream(null);
          break;
        case "conversation":
          api.conversation(conv.id).then((d) => {
            setConv(d.conversation);
            setDraft(d.pendingDraft);
          });
          break;
      }
    };
    return () => es.close();
  }, [conv?.id]);

  // ── autoscroll ────────────────────────────────────────────────────────────
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, stream]);

  // última mensagem do agent com opções → resposta rápida por clique ou tecla
  const lastOptions = useMemo(() => {
    const lastAgent = [...messages].reverse().find((m) => m.sender === "agent");
    const card = lastAgent?.cards?.find((c) => c.type === "options") as
      | { options: string[] }
      | undefined;
    return card?.options ?? [];
  }, [messages]);

  const send = useCallback(
    async (text: string) => {
      const t = text.trim();
      if (!t || !conv || sending) return;
      setSending(true);
      setInput("");
      try {
        const r = await api.sendMessage(conv.id, t);
        if (!seen.current.has(r.message.id)) {
          seen.current.add(r.message.id);
          setMessages((ms) => [...ms, r.message]);
        }
        setUsage(r.usage);
      } catch (e) {
        if (e instanceof ApiError && e.code === "daily_limit") {
          setError(e.message);
        } else {
          setError("Não consegui enviar — tente de novo.");
        }
        setInput(t);
      } finally {
        setSending(false);
        inputRef.current?.focus();
      }
    },
    [conv, sending, setUsage],
  );

  // atalhos 1..n para as opções do último turno
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (document.activeElement === inputRef.current) return;
      if (lastOptions.length === 0 || stream) return;
      const idx = Number(ev.key) - 1;
      if (idx >= 0 && idx < lastOptions.length) void send(lastOptions[idx]!);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [lastOptions, stream, send]);

  // ⌘/Ctrl+Enter confirma o rascunho
  const confirmDraft = useCallback(async () => {
    if (!conv || !draft || draftBusy) return;
    setDraftBusy(true);
    try {
      const r = await api.confirmDraft(conv.id, draft.id);
      setDraft(null);
      if (!seen.current.has(r.message.id)) {
        seen.current.add(r.message.id);
        setMessages((ms) => [...ms, r.message]);
      }
    } catch {
      setError("O serviço de chamados está instável — tente confirmar de novo.");
    } finally {
      setDraftBusy(false);
    }
  }, [conv, draft, draftBusy]);

  const cancelDraft = useCallback(async () => {
    if (!conv || !draft || draftBusy) return;
    setDraftBusy(true);
    try {
      const r = await api.cancelDraft(conv.id, draft.id);
      setDraft(null);
      if (!seen.current.has(r.message.id)) {
        seen.current.add(r.message.id);
        setMessages((ms) => [...ms, r.message]);
      }
    } finally {
      setDraftBusy(false);
    }
  }, [conv, draft, draftBusy]);

  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if ((ev.metaKey || ev.ctrlKey) && ev.key === "Enter") void confirmDraft();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [confirmDraft]);

  if (!user) return null;
  const closed = conv?.status === "closed";

  return (
    <div className="chat">
      <TopBar here="Atendimento" right={<OnlinePill />} />
      <div className="chat-main">
        <div className="chat-col">
          <div className="messages scroll-thin" ref={scrollRef}>
            {!conv && !error && (
              <>
                <div className="msg agent"><div className="bubble skeleton" style={{ width: "58%", height: 54 }} /></div>
                <div className="msg user"><div className="bubble skeleton" style={{ width: "36%", height: 42 }} /></div>
                <div className="msg agent"><div className="bubble skeleton" style={{ width: "66%", height: 68 }} /></div>
              </>
            )}
            {messages.map((m) => (
              <MessageView
                key={m.id}
                m={m}
                onPickOption={(o) => void send(o)}
                onPickTicket={(t) => void send(t)}
                optionsDisabled={!!stream || sending}
              />
            ))}
            {stream && (
              <div className="msg agent">
                <StepsLine steps={stream.steps} live />
                <div className={`bubble ${stream.text ? "" : "typing"}`}>
                  {stream.text || (
                    <span className="typing" style={{ display: "inline-flex", gap: 4 }}>
                      <i /> <i /> <i />
                    </span>
                  )}
                </div>
              </div>
            )}
            {draft && conv && (
              <div className="msg agent">
                <DraftCard
                  draft={draft}
                  busy={draftBusy}
                  onConfirm={() => void confirmDraft()}
                  onCancel={() => void cancelDraft()}
                  onEdit={() => inputRef.current?.focus()}
                />
              </div>
            )}
            {error && (
              <div className="msg system-msg">
                <span className="sys-label" style={{ color: "var(--danger-text)" }}>
                  <IconInfo size={13} /> {error}
                </span>
              </div>
            )}
          </div>
          <div className="composer-area">
            {closed ? (
              <div className="composer-locked">Conversa encerrada — recarregue para iniciar outra.</div>
            ) : (
              <form
                className="composer"
                onSubmit={(e) => {
                  e.preventDefault();
                  void send(input);
                }}
              >
                <input
                  ref={inputRef}
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  placeholder="Escreva para o Nexo…"
                  aria-label="Mensagem para o Nexo Assist"
                  maxLength={2000}
                />
                <button className="btn btn-primary send" type="submit" disabled={sending || !input.trim()}>
                  <IconSend size={14} />
                  Enviar
                </button>
              </form>
            )}
            <div className="composer-meta">
              <span>
                {conv?.status === "with_analyst"
                  ? `Você está falando com ${conv.analystName ?? "um analista"} · analista`
                  : ""}
              </span>
              <span>
                {usage ? `${usage.used}/${usage.limit}` : "–/30"} mensagens hoje
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── uma mensagem ────────────────────────────────────────────────────────────

function MessageView({
  m,
  onPickOption,
  onPickTicket,
  optionsDisabled,
}: {
  m: Message;
  onPickOption: (o: string) => void;
  onPickTicket: (t: string) => void;
  optionsDisabled: boolean;
}) {
  if (m.sender === "system") {
    return (
      <div className="msg system-msg">
        <span className="line" />
        <span className="sys-label">
          <IconInfo size={13} />
          {m.text} · {fmtTime(m.createdAt)}
        </span>
        <span className="line" />
      </div>
    );
  }
  if (m.sender === "user") {
    return (
      <div className="msg user">
        <div className="bubble">{m.text}</div>
      </div>
    );
  }
  const who = m.sender === "agent" ? "Nexo Assist" : "Analista";
  return (
    <div className="msg agent">
      {m.sender === "agent" ? (
        m.steps && m.steps.length > 0 ? (
          <StepsLine steps={m.steps} />
        ) : (
          <div className="steps-line">
            <span className="who">{who}</span>
          </div>
        )
      ) : (
        <div className="steps-line">
          <span className="who">{who}</span>
        </div>
      )}
      <div className="bubble">{m.text}</div>
      {m.cards?.map((c, i) => (
        <CardView
          key={i}
          card={c}
          onPickOption={onPickOption}
          onPickTicket={onPickTicket}
          disabled={optionsDisabled}
        />
      ))}
    </div>
  );
}

function CardView({
  card,
  onPickOption,
  onPickTicket,
  disabled,
}: {
  card: CardPayload;
  onPickOption: (o: string) => void;
  onPickTicket: (t: string) => void;
  disabled: boolean;
}) {
  switch (card.type) {
    case "options":
      return <OptionButtons options={card.options} onPick={onPickOption} disabled={disabled} />;
    case "ticket_selector":
      return <TicketSelector ticketIds={card.ticketIds} onPick={onPickTicket} disabled={disabled} />;
    case "ticket":
      return <TicketCard ticketId={card.ticketId} />;
    case "draft":
      return null; // rascunho vivo é renderizado pelo pendingDraft
  }
}

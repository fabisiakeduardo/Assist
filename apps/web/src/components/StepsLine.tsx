import { useState } from "react";
import type { AgentStep } from "../types";
import { IconCheck } from "./icons";

// ─── Linha de passos do agent (transparência) ────────────────────────────────
// Cada chip mostra o que o agent fez; clique expande o detalhe inspecionável
// (observação, nome da tool e latência medida). Usado no chat do funcionário
// e no console do analista.

export function StepsLine({
  steps,
  live,
  who = "Nexo Assist",
}: {
  steps: AgentStep[];
  live?: boolean;
  who?: string;
}) {
  return (
    <div className="steps-line">
      {who ? <span className="who">{who}</span> : null}
      {steps.map((s, i) => (
        <StepChip key={i} s={s} live={live && i === steps.length - 1} />
      ))}
    </div>
  );
}

function StepChip({ s, live }: { s: AgentStep; live?: boolean | undefined }) {
  const [open, setOpen] = useState(false);
  const hasDetail = Boolean(s.detail || s.tool || s.ms !== undefined);
  return (
    <button
      type="button"
      className={`step-chip ${live ? "doing" : ""} ${open ? "open" : ""} ${hasDetail ? "clickable" : ""}`}
      onClick={hasDetail ? () => setOpen((v) => !v) : undefined}
      title={hasDetail ? "clique para inspecionar o passo" : undefined}
    >
      <IconCheck size={12} />
      <span className="step-label">{s.label}</span>
      {open && hasDetail ? (
        <span className="step-detail">
          {s.detail ? <em>{s.detail}</em> : null}
          {s.tool ? <code>{s.tool}</code> : null}
          {s.ms !== undefined ? <span className="ms">{s.ms} ms</span> : null}
        </span>
      ) : null}
    </button>
  );
}

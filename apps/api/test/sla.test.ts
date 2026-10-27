import { describe, expect, it } from "vitest";
import {
  addBusinessDays,
  addBusinessHours,
  computeDueAt,
  isOverdue,
  slaLabel,
} from "../src/domain/sla.js";
import { normalize, similarity, squash } from "../src/domain/text.js";
import { classifyPriority } from "../src/agent/tools.js";

// ─── SLA / horário útil (seg–sex 08:00–18:00) ────────────────────────────────

describe("computeDueAt — regras do Anexo A", () => {
  it("crítica: +1h corrida (vale fim de semana)", () => {
    const sat = new Date("2026-10-24T10:00:00"); // sábado
    const due = computeDueAt("critica", sat);
    expect(due.getTime()).toBe(sat.getTime() + 3_600_000);
  });

  it("alta: +4h úteis dentro do mesmo dia", () => {
    const mon = new Date("2026-10-26T09:00:00"); // segunda
    const due = computeDueAt("alta", mon);
    expect(due.getHours()).toBe(13);
    expect(due.getDay()).toBe(1);
  });

  it("alta: transborda para o próximo dia útil", () => {
    const fri = new Date("2026-10-23T16:00:00"); // sexta 16h → 2h hoje + 2h segunda
    const due = computeDueAt("alta", fri);
    expect(due.getDay()).toBe(1); // segunda
    expect(due.getHours()).toBe(10);
  });

  it("alta aberta no fim de semana começa segunda 08:00", () => {
    const sat = new Date("2026-10-24T14:00:00");
    const due = computeDueAt("alta", sat);
    expect(due.getDay()).toBe(1);
    expect(due.getHours()).toBe(12);
  });

  it("média: +3 dias úteis pulando o fim de semana", () => {
    const wed = new Date("2026-10-21T10:00:00"); // quarta
    const due = computeDueAt("media", wed);
    expect(due.getDay()).toBe(1); // qui, sex, seg
  });

  it("baixa: +5 dias úteis", () => {
    const mon = new Date("2026-10-26T10:00:00");
    const due = computeDueAt("baixa", mon);
    expect(due.getDay()).toBe(1); // segunda seguinte
    expect(due.getDate()).toBe(2); // 2 de nov
  });
});

describe("addBusinessHours / addBusinessDays", () => {
  it("começa no horário útil se chamado aberto antes das 8h", () => {
    const early = new Date("2026-10-26T06:30:00"); // segunda 6:30
    const due = addBusinessHours(early, 4);
    expect(due.getHours()).toBe(12); // 08:00 + 4h
  });

  it("depois das 18h joga para o dia seguinte", () => {
    const late = new Date("2026-10-26T19:00:00");
    const due = addBusinessHours(late, 2);
    expect(due.getDate()).toBe(27);
    expect(due.getHours()).toBe(10);
  });

  it("addBusinessDays nunca cai em fim de semana", () => {
    const fri = new Date("2026-10-23T10:00:00");
    const due = addBusinessDays(fri, 1);
    expect(due.getDay()).toBe(1);
  });
});

describe("slaLabel / isOverdue", () => {
  it("rótulos de prazo", () => {
    expect(slaLabel("critica")).toBe("em até 1 hora");
    expect(slaLabel("alta")).toBe("em até 4 h úteis");
    expect(slaLabel("media")).toBe("em até 3 dias úteis");
    expect(slaLabel("baixa")).toBe("em até 5 dias úteis");
  });

  it("overdue olha para o passado", () => {
    expect(isOverdue("2000-01-01T00:00:00Z")).toBe(true);
    expect(isOverdue("2999-01-01T00:00:00Z")).toBe(false);
  });
});

// ─── classificação de prioridade (matriz do Anexo A) ─────────────────────────

describe("classifyPriority", () => {
  const base = { kind: "INC" as const, impact: "self" as const, blocksWork: false, deadlineToday: false, hasWorkaround: false };

  it("equipe/empresa parada → crítica", () => {
    expect(classifyPriority({ ...base, impact: "team", blocksWork: true }).priority).toBe("critica");
    expect(classifyPriority({ ...base, impact: "company", blocksWork: true }).priority).toBe("critica");
  });

  it("uma pessoa sem conseguir trabalhar → alta", () => {
    expect(classifyPriority({ ...base, blocksWork: true }).priority).toBe("alta");
  });

  it("compromisso ainda hoje → alta", () => {
    expect(classifyPriority({ ...base, deadlineToday: true }).priority).toBe("alta");
    expect(classifyPriority({ ...base, impact: "team", deadlineToday: true }).priority).toBe("alta");
  });

  it("atrapalha mas tem alternativa → média", () => {
    expect(classifyPriority({ ...base, hasWorkaround: true }).priority).toBe("media");
  });

  it("pedido sem urgência → baixa", () => {
    expect(classifyPriority({ ...base, kind: "REQ" }).priority).toBe("baixa");
  });

  it("incidente pontual sem bloqueio → média", () => {
    expect(classifyPriority({ ...base }).priority).toBe("media");
  });
});

// ─── normalização de texto ───────────────────────────────────────────────────

describe("normalize / squash / similarity", () => {
  it("remove acentos e baixa caixa", () => {
    expect(normalize("Conexão VPN não está funcionando às 14h")).toBe(
      "conexao vpn nao esta funcionando as 14h",
    );
  });

  it("squash remove pontuação (comparação com botões)", () => {
    expect(squash("Não resolveu — abrir chamado")).toBe("nao resolveu abrir chamado");
    expect(squash("Nao resolveu � abrir chamado")).toBe("nao resolveu abrir chamado");
  });

  it("similarity pega sobreposição de palavras", () => {
    expect(similarity("VPN caindo erro 809", "VPN com erro 809 no Windows 10")).toBeGreaterThan(0.3);
    expect(similarity("quero férias", "impressora quebrada")).toBe(0);
  });
});

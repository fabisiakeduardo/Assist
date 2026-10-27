# Avaliação do agent (`npm run eval`)

> Gerado em 2026-10-27 19:41 UTC · engine `scripted` (determinístico, sem LLM).

Cada cenário simula uma conversa real do funcionário contra a stack completa
(store + TicketService + HelpCenter + engine) e verifica texto, passos de
transparência, cards e efeitos colaterais no banco.

| Cenário | O que exercita | Cobre | Resultado |
| --- | --- | --- | --- |
| `help-first` | Central de ajuda antes de abrir chamado | pergunta how-to → artigo da central + oferta, sem rascunho ainda | ✅ passa |
| `intake-confirm` | Relato → impacto → rascunho → confirmação → chamado | intake com dedup + ajuda, prioridade 'alta' por compromisso hoje, criação só após confirmar | ✅ passa |
| `dedup` | Deduplicação oferece atualizar chamado existente | regra do Anexo A — não duplicar chamado aberto do mesmo assunto | ✅ passa |
| `privacy` | Chamado de outra pessoa não é revelado | privacidade — funcionário só enxerga os próprios chamados | ✅ passa |
| `sla-critical` | Empresa parada → prioridade crítica | matriz de prioridade — impacto company + bloqueio = crítica (SLA 1h) | ✅ passa |
| `transfer` | Pedido explícito transfere e pausa o agent | transferência com resumo + status waiting_analyst | ✅ passa |
| `resolved-old` | Chamado resolvido há >7 dias → oferece novo (não reabre) | janela de reabertura do Anexo A — fora dela, novo rascunho | ✅ passa |
| `resolved-recent` | Chamado resolvido há ≤7 dias reabre com a nota | janela de reabertura — dentro dela, reabre e recalcula prazo | ✅ passa |
| `off-topic` | Assunto fora de TI é redirecionado | escopo — RH/financeiro/facilities não entram no service desk | ✅ passa |
| `draft-pending-status` | Pergunta de status com rascunho pendente não vira correção | estado — intenção clara nova não é engolida pelo rascunho | ✅ passa |
| `win11-809` | Windows 11 + erro 809 não oferece artigo do Win10 | filtro de aplicabilidade da central — o artigo só cobre Windows 10 | ✅ passa |

**11/11 cenários passando.**

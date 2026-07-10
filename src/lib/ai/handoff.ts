import type { ChatMessage } from './types'

/** Longest the quoted customer message runs before we ellipsize it -
 *  keeps the internal note to a glanceable one-liner. */
const MAX_QUOTE_LEN = 160

export type HandoffReason =
  | 'human_requested'
  | 'customer_frustrated'
  | 'needs_business_review'
  | 'missing_information'

/**
 * Build the short internal note the auto-reply bot leaves on a
 * conversation when it hands off to a human. Deterministic - composed
 * from context we already have (no extra LLM call / token spend), so it
 * can't fail or add latency to the handoff.
 *
 * `replyCount` is the bot's auto-reply tally for the thread (0 when it
 * bailed on the very first inbound without answering).
 */
export function buildHandoffSummary(args: {
  messages: ChatMessage[]
  replyCount: number
  reason?: HandoffReason
}): string {
  const { messages, replyCount } = args

  const lastCustomer = [...messages]
    .reverse()
    .find((m) => m.role === 'user' && m.content.trim())

  const replies =
    replyCount === 0
      ? 'sem responder automaticamente'
      : `apos ${replyCount} ${replyCount === 1 ? 'resposta' : 'respostas'}`

  const reason = args.reason ?? inferHandoffReason(messages)
  const base = `IA encaminhou para humano ${replies}. Motivo: ${handoffReasonLabel(reason)}.`

  if (!lastCustomer) return base

  const quote = truncate(lastCustomer.content.trim(), MAX_QUOTE_LEN)
  const suggestion = suggestsCalendarFollowUp(lastCustomer.content)
    ? " Sugestao: agendar retorno ou reuniao para o especialista."
    : ""
  return `${base} Ultima mensagem do cliente: "${quote}"${suggestion}`
}

export function inferHandoffReason(messages: ChatMessage[]): HandoffReason {
  const lastCustomer =
    [...messages]
      .reverse()
      .find((m) => m.role === 'user' && m.content.trim())
      ?.content.toLowerCase() ?? ''

  if (/\b(humano|atendente|especialista|consultor|pessoa|gerente|falar com|atendimento humano)\b/i.test(lastCustomer)) {
    return 'human_requested'
  }

  if (/\b(reclam|problema|insatisfeit|chatead|raiva|cancelar|reembolso|urgente|pessim|horrivel)\b/i.test(lastCustomer)) {
    return 'customer_frustrated'
  }

  if (/\b(preco|orcamento|contrato|proposta|pagamento|desconto|prazo|valor|reuniao|agendar)\b/i.test(lastCustomer)) {
    return 'needs_business_review'
  }

  return 'missing_information'
}

export function handoffReasonLabel(reason: HandoffReason): string {
  switch (reason) {
    case 'human_requested':
      return 'cliente pediu atendimento humano'
    case 'customer_frustrated':
      return 'cliente demonstrou insatisfacao ou urgencia'
    case 'needs_business_review':
      return 'precisa de avaliacao comercial'
    case 'missing_information':
    default:
      return 'IA nao tinha informacao suficiente'
  }
}

function suggestsCalendarFollowUp(text: string): boolean {
  return /\b(reuniao|demonstra|demo|retorno|proposta|orcamento|agenda|agendar)\b/i.test(text)
}

function truncate(text: string, max: number): string {
  const collapsed = text.replace(/\s+/g, ' ')
  if (collapsed.length <= max) return collapsed
  return `${collapsed.slice(0, max - 3).trimEnd()}...`
}

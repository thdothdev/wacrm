import { describe, it, expect } from 'vitest'
import { buildHandoffSummary, inferHandoffReason } from './handoff'

describe('buildHandoffSummary', () => {
  it('notes the reply count, reason, and quotes the last customer message', () => {
    const summary = buildHandoffSummary({
      messages: [
        { role: 'user', content: 'Oi' },
        { role: 'assistant', content: 'Ola! Como posso ajudar?' },
        { role: 'user', content: 'Quero falar com um atendente' },
      ],
      replyCount: 2,
    })
    expect(summary).toBe(
      'IA encaminhou para humano apos 2 respostas. Motivo: cliente pediu atendimento humano. Ultima mensagem do cliente: "Quero falar com um atendente"',
    )
  })

  it('uses the singular reply label for a count of one', () => {
    const summary = buildHandoffSummary({
      messages: [{ role: 'user', content: 'preciso de preco' }],
      replyCount: 1,
    })
    expect(summary).toContain('apos 1 resposta.')
  })

  it('says it did not auto-reply when the bot bailed on the first inbound', () => {
    const summary = buildHandoffSummary({
      messages: [{ role: 'user', content: 'agent please' }],
      replyCount: 0,
    })
    expect(summary).toContain('sem responder automaticamente.')
    expect(summary).toContain('"agent please"')
  })

  it('picks the most recent customer turn, ignoring assistant turns', () => {
    const summary = buildHandoffSummary({
      messages: [
        { role: 'user', content: 'primeira' },
        { role: 'user', content: 'segunda' },
        { role: 'assistant', content: 'uma resposta' },
      ],
      replyCount: 1,
    })
    expect(summary).toContain('"segunda"')
  })

  it('collapses whitespace and truncates a long message', () => {
    const long = 'x'.repeat(300)
    const summary = buildHandoffSummary({
      messages: [{ role: 'user', content: long }],
      replyCount: 0,
    })
    expect(summary).toContain('...')
    expect(summary.length).toBeLessThan(300)
  })

  it('degrades gracefully when there is no customer message', () => {
    const summary = buildHandoffSummary({
      messages: [{ role: 'assistant', content: 'greeting' }],
      replyCount: 0,
    })
    expect(summary).toBe(
      'IA encaminhou para humano sem responder automaticamente. Motivo: IA nao tinha informacao suficiente.',
    )
  })
})

describe('inferHandoffReason', () => {
  it('classifies human requests, frustration, and commercial review', () => {
    expect(inferHandoffReason([{ role: 'user', content: 'quero falar com humano' }])).toBe('human_requested')
    expect(inferHandoffReason([{ role: 'user', content: 'isso e urgente, estou insatisfeito' }])).toBe('customer_frustrated')
    expect(inferHandoffReason([{ role: 'user', content: 'preciso de uma proposta' }])).toBe('needs_business_review')
  })
})

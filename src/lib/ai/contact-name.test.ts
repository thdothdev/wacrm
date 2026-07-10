import { describe, expect, it } from 'vitest'
import { extractCustomerNameFromAiReply } from './contact-name'

describe('extractCustomerNameFromAiReply', () => {
  it('extracts a customer name from an AI greeting', () => {
    expect(extractCustomerNameFromAiReply('Ol\u00e1, Matheus! Como posso ajudar?')).toBe('Matheus')
    expect(extractCustomerNameFromAiReply('Perfeito, Ana Silva. Vou verificar isso.')).toBe('Ana Silva')
  })

  it('ignores generic greetings without a real name', () => {
    expect(extractCustomerNameFromAiReply('Oi! Tudo bem?')).toBeNull()
    expect(extractCustomerNameFromAiReply('Ol\u00e1, tudo bem? Posso ajudar?')).toBeNull()
    expect(extractCustomerNameFromAiReply('Bom dia! Sou a Lumi, assistente virtual.')).toBeNull()
    expect(extractCustomerNameFromAiReply('Ol\u00e1, 558181587312!')).toBeNull()
  })
})
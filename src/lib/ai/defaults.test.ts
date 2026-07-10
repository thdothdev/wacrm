import { describe, expect, it } from 'vitest'
import { buildSystemPrompt, HANDOFF_SENTINEL } from './defaults'

describe('buildSystemPrompt', () => {
  it('asks for the customer name early and does not hand off on permission questions', () => {
    const prompt = buildSystemPrompt({ userPrompt: null, mode: 'auto_reply' })
    expect(prompt).toContain('ask their name')
    expect(prompt).toContain('Do not ask whether the customer wants handoff')
    expect(prompt).toContain(HANDOFF_SENTINEL)
  })
})

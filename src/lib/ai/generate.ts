import {
  AiError,
  type AiConfig,
  type AiUsage,
  type ChatMessage,
  type GenerateResult,
} from './types'
import { HANDOFF_SENTINEL, aiRequestTimeoutMs } from './defaults'
import { generateOpenAi } from './providers/openai'
import { generateAnthropic } from './providers/anthropic'

export interface GenerateArgs {
  config: AiConfig
  /** Fully-built system prompt (see `buildSystemPrompt`). */
  systemPrompt: string
  /** Recent conversation turns, oldest first. */
  messages: ChatMessage[]
}

/**
 * Generate the next reply from the account's configured provider.
 * Dispatches to the right adapter, then parses the handoff sentinel out
 * of the raw text. Throws `AiError` on any provider/network failure.
 */
export async function generateReply(args: GenerateArgs): Promise<GenerateResult> {
  const { config, systemPrompt, messages } = args
  const timeoutMs = aiRequestTimeoutMs()
  const providerArgs = {
    apiKey: config.apiKey,
    model: config.model,
    systemPrompt,
    messages,
    timeoutMs,
  }

  let result: { text: string; usage: AiUsage | null }
  switch (config.provider) {
    case 'openai':
      result = await generateOpenAi(providerArgs)
      break
    case 'anthropic':
      result = await generateAnthropic(providerArgs)
      break
    default:
      throw new AiError(`Unsupported AI provider: ${config.provider}`, {
        code: 'unsupported_provider',
        status: 400,
      })
  }

  return parseGeneration(result.text, result.usage)
}

/**
 * Split the raw model output into `{ text, handoff, usage }`. The
 * sentinel can appear alone or trailing a partial reply; either way we
 * treat the turn as a handoff and strip the marker from any remaining
 * text. `usage` is passed straight through (null when the provider
 * didn't report it).
 */
export function parseGeneration(
  raw: string,
  usage: AiUsage | null = null,
): GenerateResult {
  const text = raw.split(HANDOFF_SENTINEL).join('').trim()
  const handoff = raw.includes(HANDOFF_SENTINEL) || looksLikeHandoffReply(text)
  return { text, handoff, usage }
}

function looksLikeHandoffReply(text: string): boolean {
  const normalized = text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()

  const mentionsHandoffTarget = /\b(especialista|atendente|humano|equipe|consultor)\b/.test(normalized)
  const mentionsHandoffAction = /\b(encaminh|transfer|direcion)\w*\b/.test(normalized)
  if (!mentionsHandoffAction || !mentionsHandoffTarget) return false

  const isQuestionOrOffer =
    text.includes('?') ||
    /\b(quer|deseja|gostaria|prefere|posso|podemos|devo)\b.{0,40}\b(encaminh|transfer|direcion)\w*/.test(normalized) ||
    /\b(encaminh|transfer|direcion)\w*.{0,40}\b(quer|deseja|gostaria|prefere)\b/.test(normalized) ||
    /\bse\s+(quiser|preferir)\b/.test(normalized)
  if (isQuestionOrOffer) return false

  return (
    /\b(vou|irei|iremos|estou|estamos|ja|agora)\b.{0,40}\b(encaminh|transfer|direcion)\w*/.test(normalized) ||
    /\b(encaminhei|encaminharei|encaminharemos|transferi|transferirei|transferiremos|direcionei|direcionarei|direcionaremos)\b/.test(normalized) ||
    /\b(sera|serao|foi|foram)\b.{0,30}\b(encaminh|transfer|direcion)\w*/.test(normalized)
  )
}

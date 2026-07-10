import { AiError, type ChatMessage, type ProviderResult } from '../types'
import { MAX_OUTPUT_TOKENS } from '../defaults'
import {
  mergeConsecutive,
  normalizeUsage,
  providerHttpError,
  toNetworkError,
  type ProviderArgs,
} from './shared'

const OPENAI_URL = 'https://api.openai.com/v1/responses'

interface OpenAiResponse {
  output_text?: string
  output?: Array<{
    type?: string
    content?: Array<{ type?: string; text?: string; refusal?: string }>
  }>
  incomplete_details?: { reason?: string }
  usage?: {
    input_tokens?: number
    output_tokens?: number
    total_tokens?: number
    prompt_tokens?: number
    completion_tokens?: number
  }
}

/**
 * Call OpenAI's Responses API with the caller's own key. GPT-5/o-series
 * models can spend output tokens on reasoning, so keep effort low for
 * customer replies and read the visible output from the Responses shape.
 */
export async function generateOpenAi(args: ProviderArgs): Promise<ProviderResult> {
  const { apiKey, model, systemPrompt, messages, timeoutMs } = args

  let res: Response
  try {
    res = await fetch(OPENAI_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        instructions: systemPrompt,
        input: mergeConsecutive(messages).map(toOpenAiInput),
        max_output_tokens: MAX_OUTPUT_TOKENS,
        ...(usesReasoning(model) ? { reasoning: { effort: 'low' } } : {}),
      }),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (err) {
    throw toNetworkError(err)
  }

  if (!res.ok) {
    throw await providerHttpError('OpenAI', res)
  }

  const data = (await res.json().catch(() => null)) as OpenAiResponse | null
  const text = extractText(data)
  if (!text.trim()) {
    const reason = data?.incomplete_details?.reason
    throw new AiError(
      reason === 'max_output_tokens'
        ? 'OpenAI used the output budget before producing a visible reply.'
        : 'OpenAI returned an empty response.',
      { code: 'empty_response' },
    )
  }
  const usage = normalizeUsage({
    prompt: data?.usage?.input_tokens ?? data?.usage?.prompt_tokens,
    completion: data?.usage?.output_tokens ?? data?.usage?.completion_tokens,
    total: data?.usage?.total_tokens,
  })
  return { text, usage }
}

function toOpenAiInput(message: ChatMessage) {
  return {
    role: message.role,
    content: message.content,
  }
}

function extractText(data: OpenAiResponse | null): string {
  if (!data) return ''
  if (typeof data.output_text === 'string') return data.output_text

  return (data.output ?? [])
    .flatMap((item) => item.content ?? [])
    .map((part) => part.text ?? part.refusal ?? '')
    .filter(Boolean)
    .join('\n')
}

function usesReasoning(model: string): boolean {
  const id = model.toLowerCase()
  return id.startsWith('gpt-5') || /^o\d/.test(id)
}
import { AiError, type ChatMessage, type ProviderResult } from '../types'
import { MAX_OUTPUT_TOKENS } from '../defaults'
import {
  mergeConsecutive,
  normalizeUsage,
  providerHttpError,
  toNetworkError,
  type ProviderArgs,
} from './shared'

const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models'

interface GeminiResponse {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>
  usageMetadata?: {
    promptTokenCount?: number
    candidatesTokenCount?: number
    totalTokenCount?: number
  }
}

function normalizeForGemini(messages: ChatMessage[]): ChatMessage[] {
  const merged = mergeConsecutive(messages)
  return merged.length > 0
    ? merged
    : [{ role: 'user', content: '(The customer has not sent a message yet.)' }]
}

export async function generateGemini(args: ProviderArgs): Promise<ProviderResult> {
  const { apiKey, model, systemPrompt, messages, timeoutMs } = args

  let res: Response
  try {
    res = await fetch(`${GEMINI_URL}/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: {
        'x-goog-api-key': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents: normalizeForGemini(messages).map((message) => ({
          role: message.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: message.content }],
        })),
        generationConfig: { maxOutputTokens: MAX_OUTPUT_TOKENS },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (err) {
    throw toNetworkError(err)
  }

  if (!res.ok) throw await providerHttpError('Gemini', res)

  const data = (await res.json().catch(() => null)) as GeminiResponse | null
  const text = data?.candidates?.[0]?.content?.parts
    ?.map((part) => part.text ?? '')
    .filter(Boolean)
    .join('')
    .trim()
  if (!text) throw new AiError('Gemini returned an empty response.', { code: 'empty_response' })

  return {
    text,
    usage: normalizeUsage({
      prompt: data?.usageMetadata?.promptTokenCount,
      completion: data?.usageMetadata?.candidatesTokenCount,
      total: data?.usageMetadata?.totalTokenCount,
    }),
  }
}

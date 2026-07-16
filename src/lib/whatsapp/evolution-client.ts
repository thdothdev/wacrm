import { isIP } from 'node:net'

const V2_EVENTS = ['MESSAGES_UPSERT', 'MESSAGES_UPDATE', 'CONNECTION_UPDATE']
export type EvolutionVariant = 'v2' | 'go'
type Json = Record<string, unknown>

export class EvolutionRequestError extends Error {
  constructor(message: string, readonly status: number, readonly endpoint: string) {
    super(message)
  }
}

function url(baseUrl: string, path: string) {
  return `${baseUrl.replace(/\/$/, '')}${path}`
}

function responseMessage(data: Json, raw: string, status: number) {
  const error = data.error
  if (typeof error === 'string') return error
  if (error && typeof error === 'object' && !Array.isArray(error)) {
    const message = (error as Json).message
    if (message) return String(message)
  }
  if (Array.isArray(error) && error.length) return error.map(String).join(', ')
  if (data.message) return String(data.message)
  if (raw) return raw.slice(0, 500)
  return `Evolution API error (${status})`
}

async function evolutionRequest(
  baseUrl: string,
  apiKey: string,
  path: string,
  init: RequestInit = {},
): Promise<Json> {
  const response = await fetch(url(baseUrl, path), {
    ...init,
    headers: {
      apikey: apiKey,
      ...(init.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
      ...init.headers,
    },
  })
  const raw = await response.text()
  let data: Json = {}
  try {
    data = raw ? (JSON.parse(raw) as Json) : {}
  } catch {
    data = { message: raw }
  }
  if (!response.ok) {
    throw new EvolutionRequestError(`${init.method || 'GET'} ${path}: ${responseMessage(data, raw, response.status)}`, response.status, path)
  }
  return data
}

export function normalizeEvolutionBaseUrl(value: string) {
  const parsed = new URL(value.trim())
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('A URL deve comecar com http:// ou https://')
  }
  if (process.env.NODE_ENV === 'production' && parsed.protocol !== 'https:') {
    throw new Error('Em producao, a Evolution precisa usar HTTPS')
  }
  if (parsed.username || parsed.password) {
    throw new Error('A URL nao pode conter usuario ou senha')
  }

  const hostname = parsed.hostname.toLowerCase()
  const ipv4 = hostname.split('.').map(Number)
  const privateIpv4 =
    isIP(hostname) === 4 &&
    (ipv4[0] === 10 ||
      ipv4[0] === 127 ||
      (ipv4[0] === 169 && ipv4[1] === 254) ||
      (ipv4[0] === 172 && ipv4[1] >= 16 && ipv4[1] <= 31) ||
      (ipv4[0] === 192 && ipv4[1] === 168))
  const privateIpv6 =
    isIP(hostname) === 6 &&
    (hostname === '::1' || hostname.startsWith('fc') || hostname.startsWith('fd') || hostname.startsWith('fe80'))
  if (hostname === 'localhost' || hostname.endsWith('.local') || privateIpv4 || privateIpv6) {
    throw new Error('Use uma URL publica para o servidor Evolution')
  }

  return parsed.origin + parsed.pathname.replace(/\/$/, '')
}

function qrDataUrl(value: unknown) {
  const qr = String(value || '')
  if (!qr) return null
  return qr.startsWith('data:') ? qr : `data:image/png;base64,${qr}`
}

export function isEvolutionConnected(state: unknown) {
  return ['open', 'connected', 'true'].includes(String(state).toLowerCase())
}

export async function createEvolutionInstance(args: {
  baseUrl: string
  apiKey: string
  instanceName: string
}): Promise<{
  variant: EvolutionVariant
  qrcode: string | null
  apiKey: string
  instanceId: string | null
}> {
  try {
    const data = await evolutionRequest(args.baseUrl, args.apiKey, '/instance/create', {
      method: 'POST',
      body: JSON.stringify({
        instanceName: args.instanceName,
        qrcode: true,
        integration: 'WHATSAPP-BAILEYS',
      }),
    })
    const qrcode = data.qrcode as Json | undefined
    const instance = data.instance as Json | undefined
    return {
      variant: 'v2',
      qrcode: qrDataUrl(qrcode?.base64 || data.base64),
      apiKey: args.apiKey,
      instanceId: String(instance?.instanceId || '') || null,
    }
  } catch (error) {
    if (!(error instanceof EvolutionRequestError) || error.status !== 400) throw error
  }

  const data = await evolutionRequest(args.baseUrl, args.apiKey, '/instance/create', {
    method: 'POST',
    body: JSON.stringify({ name: args.instanceName }),
  })
  const instance = (data.data as Json | undefined) || data
  const instanceApiKey = String(instance.token || '')
  if (!instanceApiKey) throw new Error('Evolution Go criou a instancia sem retornar o token')
  return {
    variant: 'go',
    qrcode: qrDataUrl(instance.qrcode),
    apiKey: instanceApiKey,
    instanceId: String(instance.id || '') || null,
  }
}

export async function connectEvolutionInstance(args: {
  baseUrl: string
  apiKey: string
  instanceName: string
  variant?: EvolutionVariant
  instanceId?: string | null
}) {
  if (args.variant === 'go') {
    const data = await evolutionRequest(args.baseUrl, args.apiKey, '/instance/qr', {
      headers: args.instanceId ? { instanceId: args.instanceId } : undefined,
    })
    const payload = (data.data as Json | undefined) || data
    return qrDataUrl(payload.Qrcode || payload.qrcode || data.base64)
  }
  const data = await evolutionRequest(
    args.baseUrl,
    args.apiKey,
    `/instance/connect/${encodeURIComponent(args.instanceName)}`,
  )
  return qrDataUrl(data.base64)
}

export async function getEvolutionConnectionState(args: {
  baseUrl: string
  apiKey: string
  instanceName: string
  variant?: EvolutionVariant
  instanceId?: string | null
}) {
  if (args.variant === 'go') {
    const data = await evolutionRequest(args.baseUrl, args.apiKey, '/instance/status', {
      headers: args.instanceId ? { instanceId: args.instanceId } : undefined,
    })
    const payload = (data.data as Json | undefined) || data
    return payload.Connected === true || payload.connected === true ? 'open' : 'close'
  }
  const data = await evolutionRequest(
    args.baseUrl,
    args.apiKey,
    `/instance/connectionState/${encodeURIComponent(args.instanceName)}`,
  )
  const instance = data.instance as Json | undefined
  return String(instance?.state || data.state || 'close')
}

export async function setEvolutionWebhook(args: {
  baseUrl: string
  apiKey: string
  instanceName: string
  webhookUrl: string
  webhookSecret: string
  variant?: EvolutionVariant
  instanceId?: string | null
}) {
  if (args.variant === 'go') {
    const webhookUrl = new URL(args.webhookUrl)
    webhookUrl.searchParams.set('evolution_token', args.webhookSecret)
    await evolutionRequest(args.baseUrl, args.apiKey, '/instance/connect', {
      method: 'POST',
      headers: args.instanceId ? { instanceId: args.instanceId } : undefined,
      body: JSON.stringify({
        immediate: true,
        webhookUrl: webhookUrl.toString(),
        subscribe: ['MESSAGE', 'SEND_MESSAGE', 'READ_RECEIPT', 'CONNECTION', 'QRCODE'],
      }),
    })
    return
  }
  const webhookUrl = new URL(args.webhookUrl)
  webhookUrl.searchParams.set('evolution_token', args.webhookSecret)
  await evolutionRequest(
    args.baseUrl,
    args.apiKey,
    `/webhook/set/${encodeURIComponent(args.instanceName)}`,
    {
      method: 'POST',
      body: JSON.stringify({
        enabled: true,
        url: webhookUrl.toString(),
        events: V2_EVENTS,
        base64: true,
      }),
    },
  )
}

function messageId(data: Json) {
  const key = data.key as Json | undefined
  const payload = data.data as Json | undefined
  const info = payload?.Info as Json | undefined
  return String(key?.id || info?.ID || data.messageId || data.id || '')
}

export async function sendEvolutionText(args: {
  baseUrl: string
  apiKey: string
  instanceName: string
  to: string
  text: string
  variant?: EvolutionVariant
  instanceId?: string | null
}) {
  const path = args.variant === 'go'
    ? '/send/text'
    : `/message/sendText/${encodeURIComponent(args.instanceName)}`
  const body = args.variant === 'go'
    ? { number: args.to, text: args.text }
    : { number: args.to, textMessage: { text: args.text } }
  const data = await evolutionRequest(args.baseUrl, args.apiKey, path, {
    method: 'POST',
    headers: args.instanceId ? { instanceId: args.instanceId } : undefined,
    body: JSON.stringify(body),
  })
  return messageId(data)
}

export async function sendEvolutionMedia(args: {
  baseUrl: string
  apiKey: string
  instanceName: string
  to: string
  kind: 'image' | 'video' | 'document' | 'audio'
  mediaUrl: string
  caption?: string
  filename?: string
  variant?: EvolutionVariant
  instanceId?: string | null
}) {
  if (args.variant === 'go') {
    const data = await evolutionRequest(args.baseUrl, args.apiKey, '/send/media', {
      method: 'POST',
      headers: args.instanceId ? { instanceId: args.instanceId } : undefined,
      body: JSON.stringify({
        number: args.to,
        type: args.kind,
        url: args.mediaUrl,
        caption: args.caption,
        filename: args.filename,
      }),
    })
    return messageId(data)
  }

  const mediaResponse = await fetch(args.mediaUrl)
  if (!mediaResponse.ok) throw new Error('Nao foi possivel baixar o arquivo para envio')
  const form = new FormData()
  form.append('number', args.to)
  form.append('mediatype', args.kind)
  form.append(
    'media',
    await mediaResponse.blob(),
    args.filename || `arquivo.${args.kind === 'document' ? 'bin' : args.kind}`,
  )
  if (args.caption) form.append('caption', args.caption)
  if (args.filename) form.append('fileName', args.filename)

  const data = await evolutionRequest(
    args.baseUrl,
    args.apiKey,
    `/message/sendMedia/${encodeURIComponent(args.instanceName)}`,
    { method: 'POST', body: form },
  )
  return messageId(data)
}
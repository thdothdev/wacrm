import { isIP } from 'node:net'
const EVENTS = ['MESSAGES_UPSERT', 'MESSAGES_UPDATE', 'CONNECTION_UPDATE']

type Json = Record<string, unknown>

function url(baseUrl: string, path: string) {
  return `${baseUrl.replace(/\/$/, '')}${path}`
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
    const error = data.error as Json | undefined
    throw new Error(
      String(error?.message || data.message || `Evolution API error (${response.status})`),
    )
  }
  return data
}

export function normalizeEvolutionBaseUrl(value: string) {
  const parsed = new URL(value.trim())
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('A URL deve começar com http:// ou https://')
  }
  if (process.env.NODE_ENV === 'production' && parsed.protocol !== 'https:') {
    throw new Error('Em produção, a Evolution precisa usar HTTPS')
  }
  if (parsed.username || parsed.password) {
    throw new Error('A URL não pode conter usuário ou senha')
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
    throw new Error('Use uma URL pública para o servidor Evolution')
  }

  return parsed.origin + parsed.pathname.replace(/\/$/, '')
}

function qrDataUrl(value: unknown) {
  const qr = String(value || '')
  if (!qr) return null
  return qr.startsWith('data:') ? qr : `data:image/png;base64,${qr}`
}
export function isEvolutionConnected(state: unknown) {
  return String(state).toLowerCase() === 'open'
}

export async function createEvolutionInstance(args: {
  baseUrl: string
  apiKey: string
  instanceName: string
}) {
  const data = await evolutionRequest(args.baseUrl, args.apiKey, '/instance/create', {
    method: 'POST',
    body: JSON.stringify({
      instanceName: args.instanceName,
      qrcode: true,
      integration: 'WHATSAPP-BAILEYS',
    }),
  })
  const qrcode = data.qrcode as Json | undefined
  return qrDataUrl(qrcode?.base64 || data.base64)
}

export async function connectEvolutionInstance(args: {
  baseUrl: string
  apiKey: string
  instanceName: string
}) {
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
}) {
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
}) {
  await evolutionRequest(
    args.baseUrl,
    args.apiKey,
    `/webhook/set/${encodeURIComponent(args.instanceName)}`,
    {
      method: 'POST',
      body: JSON.stringify({
        enabled: true,
        url: args.webhookUrl,
        events: EVENTS,
        headers: { 'x-autoia-webhook-token': args.webhookSecret },
        base64: true,
      }),
    },
  )
}

function messageId(data: Json) {
  const key = data.key as Json | undefined
  return String(key?.id || data.messageId || data.id || '')
}

export async function sendEvolutionText(args: {
  baseUrl: string
  apiKey: string
  instanceName: string
  to: string
  text: string
}) {
  const data = await evolutionRequest(
    args.baseUrl,
    args.apiKey,
    `/message/sendText/${encodeURIComponent(args.instanceName)}`,
    {
      method: 'POST',
      body: JSON.stringify({ number: args.to, textMessage: { text: args.text } }),
    },
  )
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
}) {
  const mediaResponse = await fetch(args.mediaUrl)
  if (!mediaResponse.ok) throw new Error('Não foi possível baixar o arquivo para envio')

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
import { NextResponse, after } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { decrypt, encrypt, isLegacyFormat } from '@/lib/whatsapp/encryption'
import { getMediaUrl } from '@/lib/whatsapp/meta-api'
import { normalizePhone } from '@/lib/whatsapp/phone-utils'
import { findExistingContact, isUniqueViolation } from '@/lib/contacts/dedupe'
import {
  verifyEvolutionWebhookSignature,
  verifyMetaWebhookSignature,
  verifyUazapiWebhookSignature,
} from '@/lib/whatsapp/webhook-signature'
import { runAutomationsForTrigger } from '@/lib/automations/engine'
import { dispatchInboundToFlows } from '@/lib/flows/engine'
import { dispatchInboundToAiReply } from '@/lib/ai/auto-reply'
import { dispatchWebhookEvent } from '@/lib/webhooks/deliver'
import { ensureLeadDealForConversation } from '@/lib/pipelines/ensure-lead-deal'
import {
  handleTemplateWebhookChange,
  isTemplateWebhookField,
} from '@/lib/whatsapp/template-webhook'

// The `after()` callback in POST runs within this route's max duration.
// Inbound processing can fan out to per-media Meta verification calls, so
// give it headroom beyond the platform default (Vercel clamps this to the
// plan's ceiling). Tune as needed.
export const maxDuration = 60

// Lazy-initialized to avoid build-time crash when env vars are missing
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _adminClient: any = null
function supabaseAdmin() {
  if (!_adminClient) {
    _adminClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    )
  }
  return _adminClient
}

interface WhatsAppMessage {
  id: string
  from: string
  timestamp: string
  type: string
  text?: { body: string }
  image?: { id: string; mime_type: string; caption?: string }
  video?: { id: string; mime_type: string; caption?: string }
  document?: { id: string; mime_type: string; filename?: string; caption?: string }
  audio?: { id: string; mime_type: string }
  sticker?: { id: string; mime_type: string }
  location?: { latitude: number; longitude: number; name?: string; address?: string }
  reaction?: { message_id: string; emoji: string }
  /**
   * Set when the customer taps a button or list row on an interactive
   * message we sent. `button_reply.id` / `list_reply.id` is whatever id
   * we put on the button/row when sending — the Flows engine uses this
   * to advance the per-contact run.
   */
  interactive?: {
    type: 'button_reply' | 'list_reply'
    button_reply?: { id: string; title: string }
    list_reply?: { id: string; title: string; description?: string }
  }
  /** Present when the customer swipe-replies to one of our messages. */
  context?: { id: string }
  media_url?: string
}

interface WhatsAppWebhookEntry {
  id: string
  changes: Array<{
    value: {
      messaging_product: string
      metadata: {
        display_phone_number: string
        phone_number_id: string
      }
      contacts?: Array<{
        profile: { name: string }
        wa_id: string
      }>
      messages?: WhatsAppMessage[]
      statuses?: Array<{
        id: string
        status: string
        timestamp: string
        recipient_id: string
      }>
    }
    field: string
  }>
}

// GET - Health check / webhook verification
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url)
    const mode = searchParams.get('hub.mode')
    const challenge = searchParams.get('hub.challenge')
    const verifyToken = searchParams.get('hub.verify_token')

    // Meta API verification (legacy support if needed)
    if (mode === 'subscribe' && challenge && verifyToken) {
      // Keep old Meta flow for backward compatibility during migration
      // Fetch all whatsapp configs to check verify tokens
      const { data: configs, error: configError } = await supabaseAdmin()
        .from('whatsapp_config')
        .select('id, verify_token')

      if (configError || !configs) {
        console.error('Error fetching configs for verification:', configError)
        return NextResponse.json(
          { error: 'Verification failed' },
          { status: 403 }
        )
      }

      // Check if any config's verify_token matches
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let matchedConfig: any = null
      for (const config of configs) {
        if (!config.verify_token) continue
        try {
          if (decrypt(config.verify_token) === verifyToken) {
            matchedConfig = config
            break
          }
        } catch {
          // Malformed / wrong-key token row — skip it and keep checking.
        }
      }

      if (matchedConfig) {
        // Fire-and-forget GCM upgrade. Safe to run on every subscribe
        // since it's a no-op once the column is already GCM.
        if (isLegacyFormat(matchedConfig.verify_token)) {
          void supabaseAdmin()
            .from('whatsapp_config')
            .update({ verify_token: encrypt(verifyToken) })
            .eq('id', matchedConfig.id)
            .then(({ error }: { error: unknown }) => {
              if (error) {
                console.warn(
                  '[webhook] verify_token GCM upgrade failed:',
                  (error as { message?: string })?.message ?? error,
                )
              }
            })
        }
        // Return challenge as plain text
        return new Response(challenge, {
          status: 200,
          headers: { 'Content-Type': 'text/plain' },
        })
      }

      return NextResponse.json(
        { error: 'Verification token mismatch' },
        { status: 403 }
      )
    }

    // uazapi doesn't use hub.challenge verification — simple health check
    return NextResponse.json({ status: 'webhook_ready' }, { status: 200 })
  } catch (error) {
    console.error('Error in webhook GET verification:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}

// POST - Receive messages
export async function POST(request: Request) {
  // Read raw body and headers for signature validation
  const rawBody = await request.text()
  const signature = request.headers.get('x-hub-signature-256')
  const authorization = request.headers.get('authorization')
  const requestUrl = new URL(request.url)
  const evolutionToken =
    request.headers.get('x-autoia-webhook-token') ||
    requestUrl.searchParams.get('evolution_token')
  const urlToken = requestUrl.searchParams.get('uazapi_token')

  let body:
    | { entry?: WhatsAppWebhookEntry[] }
    | { event?: string; data?: unknown }
    | Record<string, unknown>
  try {
    body = JSON.parse(rawBody)
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  // Try to determine which API format this is:
  // - Meta uses x-hub-signature-256 header
  // - uazapi uses a secret URL token because its dashboard has no custom header field.
  const isMetaFormat = signature !== null
  const isEvolutionFormat = !isMetaFormat && isEvolutionWebhookBody(body)
  const isUazapiFormat = !isMetaFormat && !isEvolutionFormat

  let matchedEvolutionConfig: { account_id: string; user_id: string } | null = null

  // Verify based on detected format
  if (isMetaFormat) {
    if (!verifyMetaWebhookSignature(rawBody, signature)) {
      console.warn('[webhook] rejected Meta request with invalid signature')
      return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
    }
  } else if (isEvolutionFormat) {
    const instanceName = getEvolutionInstanceName(body)
    if (!instanceName) {
      return NextResponse.json({ error: 'Missing Evolution instance' }, { status: 401 })
    }
    let configQuery = supabaseAdmin()
      .from('whatsapp_config')
      .select('account_id, user_id, evolution_webhook_secret')
      .eq('provider', 'evolution')
    const goInstanceId = getString(getRecord(body), ['instanceId'])
    configQuery = goInstanceId
      ? configQuery.eq('instance_id', goInstanceId)
      : configQuery.eq('evolution_instance_name', instanceName)
    const { data: configs, error } = await configQuery
    if (error || !configs?.length) {
      console.warn('[webhook] rejected unknown Evolution instance:', instanceName)
      return NextResponse.json({ error: 'Unknown Evolution instance' }, { status: 401 })
    }
    for (const config of configs) {
      try {
        const expectedToken = decrypt(config.evolution_webhook_secret)
        if (verifyEvolutionWebhookSignature(evolutionToken, expectedToken)) {
          matchedEvolutionConfig = { account_id: config.account_id, user_id: config.user_id }
          break
        }
      } catch {
        console.error('[webhook] Evolution webhook token could not be decrypted')
      }
    }
    if (!matchedEvolutionConfig) {
      console.warn('[webhook] rejected Evolution request with invalid token')
      return NextResponse.json({ error: 'Invalid webhook token' }, { status: 401 })
    }
    console.log('[webhook] Evolution webhook accepted:', instanceName)
  } else if (isUazapiFormat) {
    if (!isUazapiWebhookBody(body)) {
      console.warn(
        '[webhook] rejected request with no recognized provider payload; payload keys:',
        describePayloadKeys(body),
      )
      return NextResponse.json({ error: 'Missing verification' }, { status: 401 })
    }
    if (!verifyUazapiWebhookSignature(authorization, urlToken)) {
      console.warn('[webhook] rejected uazapi request with invalid webhook token')
      return NextResponse.json({ error: 'Invalid webhook token' }, { status: 401 })
    }
    console.log('[webhook] uazapi webhook accepted')
  } else {
    console.warn('[webhook] rejected request with no recognized provider payload')
    return NextResponse.json({ error: 'Missing verification' }, { status: 401 })
  }
  // Process AFTER the response so we ack the provider within their timeout
  // (Meta ~20s, uazapi ~30s). A slow ack triggers retries + duplicate inserts.
  //
  // This MUST use `after()` rather than a detached `processWebhook(body)`
  // promise: on serverless platforms (we run on Vercel) the function can
  // be frozen or terminated the moment the response is sent, so a floating
  // promise's DB writes are not guaranteed to finish. That dropped a
  // non-deterministic *subset* of inbound messages — contacts/conversations
  // were created but the message insert never landed, leaving conversations
  // that show in the inbox with an empty thread, and no logs to explain it
  // (see issue #301). `after()` hands the callback to the runtime, which
  // keeps the function alive until it resolves (within the route's
  // maxDuration).
  after(async () => {
    try {
      // Detect payload format and route to appropriate handler
      if (isEvolutionFormat) {
        await processEvolutionWebhook(body, matchedEvolutionConfig!)
      } else if (isUazapiFormat) {
        // uazapi format: { event: '...', data: {...} }
        await processUazapiWebhook(normalizeUazapiWebhookBody(body))
      } else {
        // Meta format: { entry: [...] }
        await processWebhook(body as { entry?: WhatsAppWebhookEntry[] })
      }
    } catch (error) {
      console.error('Error processing webhook:', error)
    }
  })

  return NextResponse.json({ status: 'received' }, { status: 200 })
}

function getEvolutionInstanceName(body: unknown): string | undefined {
  const record = getRecord(body)
  const instance = getRecord(record?.instance)
  return (
    getString(record, ['instance', 'instanceName', 'instanceId']) ||
    getString(instance, ['name', 'instanceName', 'id'])
  )
}

function isEvolutionWebhookBody(body: unknown): boolean {
  const record = getRecord(body)
  const event = getString(record, ['event'])?.toLowerCase().replace(/_/g, '.')
  return Boolean(
    getEvolutionInstanceName(body) &&
      event &&
      [
        'messages.upsert', 'messages.update', 'connection.update',
        'message', 'receipt', 'connected', 'loggedout', 'pairsuccess', 'qrcode',
      ].includes(event),
  )
}
function isUazapiWebhookBody(body: unknown): boolean {
  const record = getRecord(body)
  if (!record) return false
  if (getString(record, ['event', 'Event', 'eventType', 'EventType', 'type'])) {
    return true
  }
  return Boolean(
    record.instanceId ||
      record.instanceid ||
      record.instance ||
      record.messageId ||
      record.messageid ||
      record.chatId ||
      record.chatid ||
      record.data ||
      record.Data ||
      record.payload ||
      record.Payload ||
      record.key ||
      record.message
  )
}

function normalizeUazapiWebhookBody(
  body: Record<string, unknown>
): { event?: string; data?: unknown } {
  return {
    event:
      getString(body, ['event', 'Event', 'eventType', 'EventType', 'type']) ||
      'messages.new',
    data:
      getRecordValue(body, ['data', 'Data', 'payload', 'Payload']) || body,
  }
}

function getRecordValue(
  record: Record<string, unknown>,
  keys: string[]
): unknown {
  for (const key of keys) {
    if (record[key] !== undefined && record[key] !== null) return record[key]
  }
  return undefined
}

function getRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

function getString(
  record: Record<string, unknown> | undefined,
  keys: string[]
): string | undefined {
  if (!record) return undefined
  const value = getRecordValue(record, keys)
  if (typeof value === 'string') return value
  if (typeof value === 'number') return String(value)
  return undefined
}

function getPayloadRecord(data: Record<string, unknown>): Record<string, unknown> {
  const messages = data.messages
  if (Array.isArray(messages) && getRecord(messages[0])) {
    return messages[0] as Record<string, unknown>
  }

  const wrapped = getRecord(
    getRecordValue(data, [
      'data',
      'Data',
      'payload',
      'Payload',
      'messageData',
      'message_data',
      'MessageData',
    ])
  )
  if (wrapped) return getPayloadRecord(wrapped)

  const message = getRecord(getRecordValue(data, ['message', 'Message']))
  return message || data
}

function getUazapiMessageText(data: Record<string, unknown>): string | undefined {
  const direct = getString(data, ['body', 'text', 'message', 'content', 'caption'])
  if (direct) return direct

  const message = getRecord(getRecordValue(data, ['message', 'Message']))
  const extendedText = getRecord(message?.extendedTextMessage)
  return (
    getString(message, ['conversation']) ||
    getString(extendedText, ['text']) ||
    getString(getRecord(message?.imageMessage), ['caption']) ||
    getString(getRecord(message?.videoMessage), ['caption']) ||
    getString(getRecord(message?.documentMessage), ['caption'])
  )
}

function describePayloadKeys(value: unknown): string {
  const record = getRecord(value)
  if (!record) return typeof value
  return Object.keys(record).slice(0, 12).join(',') || 'empty'
}
/**
 * Process uazapi webhook events.
 * uazapi payload format:
 *   { event: 'messages.new', data: { from, text, timestamp, messageid, chatid } }
 *   { event: 'message.status', data: { id, status, timestamp, recipient_id } }
 */
async function processEvolutionWebhook(
  body: Record<string, unknown>,
  config: { account_id: string; user_id: string },
) {
  const event = getString(body, ['event'])?.toLowerCase().replace(/_/g, '.')
  const instanceName = getEvolutionInstanceName(body)
  const rawData = getRecord(body.data)
  const data = Array.isArray(body.data) ? getRecord(body.data[0]) : rawData
  if (!event || !instanceName || !data) return

  if (['connected', 'pairsuccess', 'loggedout'].includes(event)) {
    const connected = event !== 'loggedout'
    await supabaseAdmin()
      .from('whatsapp_config')
      .update({
        connection_state: connected ? 'connected' : 'disconnected',
        status: connected ? 'connected' : 'disconnected',
        connected_at: connected ? new Date().toISOString() : null,
        updated_at: new Date().toISOString(),
      })
      .eq('account_id', config.account_id)
    return
  }

  if (event === 'receipt') {
    const ids = getRecordValue(data, ['MessageIDs', 'messageIds'])
    const state = getString(body, ['state']) || getString(data, ['Type', 'type']) || 'sent'
    if (Array.isArray(ids)) {
      for (const id of ids) {
        await handleStatusUpdate({
          id: String(id),
          status: mapEvolutionStatus(state),
          timestamp: normalizeWebhookTimestamp(getRecordValue(data, ['Timestamp', 'timestamp'])),
          recipient_id: '',
        })
      }
    }
    return
  }

  if (event === 'message') {
    await processEvolutionGoMessage(data, config)
    return
  }

  if (event === 'connection.update') {
    const state = getString(data, ['state', 'status']) || 'close'
    const connected = state.toLowerCase() === 'open'
    await supabaseAdmin()
      .from('whatsapp_config')
      .update({
        connection_state: connected ? 'connected' : 'disconnected',
        status: connected ? 'connected' : 'disconnected',
        connected_at: connected ? new Date().toISOString() : null,
        updated_at: new Date().toISOString(),
      })
      .eq('account_id', config.account_id)
    return
  }

  const key = getRecord(data.key)
  if (event === 'messages.update') {
    const update = getRecord(data.update)
    const messageId = getString(key, ['id']) || getString(data, ['id', 'messageId'])
    const rawStatus = getRecordValue(update || data, ['status'])
    if (messageId && rawStatus !== undefined) {
      await handleStatusUpdate({
        id: messageId,
        status: mapEvolutionStatus(rawStatus),
        timestamp: normalizeWebhookTimestamp(getRecordValue(data, ['messageTimestamp', 'timestamp'])),
        recipient_id: '',
      })
    }
    return
  }

  if (event !== 'messages.upsert' || key?.fromMe === true) return
  const remoteJid = getString(key, ['remoteJid', 'participant']) || getString(data, ['sender'])
  const messageId = getString(key, ['id']) || getString(data, ['id', 'messageId'])
  if (!remoteJid || !messageId || /@(g\.us|broadcast|newsletter)$/.test(remoteJid)) return

  const messagePayload = getRecord(data.message) || {}
  const messageType = getString(data, ['messageType', 'type']) || Object.keys(messagePayload)[0] || 'conversation'
  const normalizedType = getUazapiMessageType(messageType)
  const content = getRecord(messagePayload[messageType]) || getRecord(messagePayload[`${normalizedType}Message`])
  const text = getUazapiMessageText(data)
  const mimeType = getString(content, ['mimetype', 'mime_type']) || 'application/octet-stream'
  const filename = getString(content, ['fileName', 'filename'])
  const rawMedia = getString(data, ['mediaUrl', 'media_url', 'url', 'base64'])
  const mediaUrl = rawMedia
    ? rawMedia.startsWith('data:') || /^https?:\/\//i.test(rawMedia)
      ? rawMedia
      : `data:${mimeType};base64,${rawMedia}`
    : undefined

  const message: WhatsAppMessage = {
    id: messageId,
    from: remoteJid,
    timestamp: normalizeWebhookTimestamp(getRecordValue(data, ['messageTimestamp', 'timestamp'])),
    type: normalizedType,
    text: text ? { body: text } : undefined,
    media_url: mediaUrl,
  }
  if (normalizedType === 'image') {
    message.image = { id: messageId, mime_type: mimeType, caption: text }
  } else if (normalizedType === 'video') {
    message.video = { id: messageId, mime_type: mimeType, caption: text }
  } else if (normalizedType === 'document') {
    message.document = { id: messageId, mime_type: mimeType, filename, caption: text }
  } else if (normalizedType === 'audio') {
    message.audio = { id: messageId, mime_type: mimeType }
  } else if (normalizedType === 'sticker') {
    message.sticker = { id: messageId, mime_type: mimeType }
  }

  const contextInfo = getRecord(content?.contextInfo)
  const quotedId = getString(contextInfo, ['stanzaId'])
  if (quotedId) message.context = { id: quotedId }

  const phone = remoteJid.split('@')[0]
  await processMessage(
    message,
    { profile: { name: getString(data, ['pushName', 'senderName']) || phone }, wa_id: phone },
    config.account_id,
    config.user_id,
    '',
  )
}

async function processEvolutionGoMessage(
  data: Record<string, unknown>,
  config: { account_id: string; user_id: string },
) {
  const info = getRecord(data.Info) || getRecord(data.info)
  if (!info || info.IsFromMe === true || info.IsGroup === true) return

  const remoteJid = getString(info, ['Chat', 'Sender', 'chat', 'sender'])
  const messageId = getString(info, ['ID', 'id'])
  if (!remoteJid || !messageId || /@(g\.us|broadcast|newsletter)$/.test(remoteJid)) return

  const payload = getRecord(data.Message) || getRecord(data.message) || {}
  const payloadKey = Object.keys(payload)[0] || 'conversation'
  const content = getRecord(payload[payloadKey])
  const declaredType = getString(info, ['MediaType', 'mediaType']) || payloadKey.replace(/Message$/i, '')
  const normalizedType = getUazapiMessageType(declaredType.toLowerCase())
  const text =
    getString(payload, ['conversation']) ||
    getString(content, ['text', 'caption']) ||
    getUazapiMessageText({ message: payload })
  const mimeType = getString(content, ['mimetype', 'mime_type']) || 'application/octet-stream'
  const filename = getString(content, ['fileName', 'filename'])
  const rawMedia = getString(data, ['base64', 'mediaUrl', 'media_url'])
  const mediaUrl = rawMedia
    ? rawMedia.startsWith('data:') || /^https?:\/\//i.test(rawMedia)
      ? rawMedia
      : `data:${mimeType};base64,${rawMedia}`
    : undefined

  const message: WhatsAppMessage = {
    id: messageId,
    from: remoteJid,
    timestamp: normalizeWebhookTimestamp(getRecordValue(info, ['Timestamp', 'timestamp'])),
    type: normalizedType,
    text: text ? { body: text } : undefined,
    media_url: mediaUrl,
  }
  if (normalizedType === 'image') {
    message.image = { id: messageId, mime_type: mimeType, caption: text }
  } else if (normalizedType === 'video') {
    message.video = { id: messageId, mime_type: mimeType, caption: text }
  } else if (normalizedType === 'document') {
    message.document = { id: messageId, mime_type: mimeType, filename, caption: text }
  } else if (normalizedType === 'audio') {
    message.audio = { id: messageId, mime_type: mimeType }
  }

  const phone = remoteJid.split('@')[0].split(':')[0]
  await processMessage(
    message,
    { profile: { name: getString(info, ['PushName', 'pushName']) || phone }, wa_id: phone },
    config.account_id,
    config.user_id,
    '',
  )
}
function normalizeWebhookTimestamp(value: unknown): string {
  const parsedDate = typeof value === 'string' ? Date.parse(value) : NaN
  const numeric = Number.isNaN(parsedDate) ? Number(value) || Date.now() : parsedDate
  return Math.floor(numeric > 10_000_000_000 ? numeric / 1000 : numeric).toString()
}

function mapEvolutionStatus(value: unknown): string {
  if (typeof value === 'number') {
    if (value >= 3) return 'read'
    if (value === 2) return 'delivered'
    if (value >= 0) return 'sent'
    return 'failed'
  }
  const status = String(value).toLowerCase()
  if (status.includes('read') || status.includes('played')) return 'read'
  if (status.includes('deliver')) return 'delivered'
  if (status.includes('fail') || status.includes('error')) return 'failed'
  return 'sent'
}
async function processUazapiWebhook(body: { event?: string; data?: unknown }) {
  const { event, data } = body

  if (!event || !data) return

  console.log('[webhook] Received uazapi event:', event)

  const eventName = event.toLowerCase()
  if (eventName.includes('status')) {
    await handleUazapiMessageStatus(data as Record<string, unknown>)
  } else if (eventName.includes('message')) {
    await handleUazapiInboundMessage(data as Record<string, unknown>)
  } else {
    console.log('[webhook] Unknown uazapi event type:', event)
  }
}

/**
 * Handle incoming messages from uazapi (messages.new event).
 * Extracts the message data, finds the config, and processes like Meta.
 */
async function handleUazapiInboundMessage(data: Record<string, unknown>) {
  try {
    // uazapi message structure:
    // {
    //   instanceId: "your-instance-id",
    //   chatId: "5521999999999",
    //   from: "5521999999999",
    //   messageId: "true_5521999999999_...",
    //   body: "Hello",
    //   type: "conversation",
    //   timestamp: 1234567890,
    //   quotedMessageId?: "...",
    //   hasMedia?: true,
    //   mediaUrl?: "..."
    // }

    const messageData = getPayloadRecord(data)
    const key = getRecord(messageData.key)
    const instance = getRecord(messageData.instance)
    const instanceId =
      getString(messageData, ['instanceId', 'instanceid', 'instanceName']) ||
      getString(instance, ['id', 'name'])
    const chatId =
      getString(messageData, ['chatId', 'chatid', 'chat_id', 'remoteJid']) ||
      getString(key, ['remoteJid', 'participant'])
    const from = getString(messageData, ['from', 'sender', 'senderId']) || chatId
    const messageId =
      getString(messageData, ['messageId', 'messageid', 'id']) ||
      getString(key, ['id'])
    const body = getUazapiMessageText(messageData)
    const messageType = getString(messageData, ['type', 'messageType'])
    const rawTimestamp = getRecordValue(messageData, ['timestamp', 'messageTimestamp'])
    const timestamp = Number(rawTimestamp) || undefined
    const hasMedia = Boolean(getRecordValue(messageData, ['hasMedia']))
    const mediaUrl = getString(messageData, ['mediaUrl', 'media_url', 'url'])
    const quotedMessageId = getString(messageData, ['quotedMessageId', 'quoted_message_id'])

    if (!from || !messageId) {
      const keys = describePayloadKeys(messageData)
      const state = getString(messageData, ['state'])
      const owner = getString(messageData, ['owner'])
      if (state || owner || keys.includes('BaseUrl')) {
        console.log('[webhook] ignoring uazapi non-message event:', keys)
        return
      }
      console.error('[webhook] uazapi message missing required fields:', {
        instanceId,
        from,
        messageId,
        payloadKeys: keys,
      })
      return
    }

    let configRows = null
    let configError = null

    if (instanceId) {
      const result = await supabaseAdmin()
        .from('whatsapp_config')
        .select('*')
        .eq('instance_id', instanceId)

      configRows = result.data
      configError = result.error
    }
    if (configError) {
      console.error(
        '[webhook] Error fetching config for instance_id:',
        instanceId,
        configError
      )
      return
    }

    if (!configRows || configRows.length === 0) {
      const { data: uazapiRows, error: fallbackError } = await supabaseAdmin()
        .from('whatsapp_config')
        .select('*')
        .not('instance_token', 'is', null)

      if (fallbackError || !uazapiRows || uazapiRows.length !== 1) {
        console.error('[webhook] No config found for uazapi instance_id:', instanceId)
        return
      }

      configRows = uazapiRows
      if (instanceId) {
        await supabaseAdmin()
          .from('whatsapp_config')
          .update({ instance_id: instanceId, updated_at: new Date().toISOString() })
          .eq('id', uazapiRows[0].id)
      }
    }

    if (configRows.length > 1) {
      console.error(
        `[webhook] Multiple configs (${configRows.length}) found for instance_id:`,
        instanceId
      )
      return
    }

    const config = configRows[0]
    const accountId = config.account_id
    const configUserId = config.user_id

    // Normalize message to WhatsAppMessage format
  const normalizedMessage: WhatsAppMessage = {
    id: messageId,
    from: chatId || from,
    timestamp: Math.floor((timestamp || Date.now()) / 1000).toString(),
    type: getUazapiMessageType(messageType),
    text: body ? { body } : undefined,
  }

    // Add media if present
    if (hasMedia && mediaUrl) {
      const mediaType = getMediaTypeFromUrl(mediaUrl)
      if (mediaType === 'image') {
        normalizedMessage.image = {
          id: messageId,
          mime_type: 'image/jpeg', // Best guess
          caption: body,
        }
        normalizedMessage.media_url = mediaUrl
      } else if (mediaType === 'video') {
        normalizedMessage.video = {
          id: messageId,
          mime_type: 'video/mp4',
          caption: body,
        }
        normalizedMessage.media_url = mediaUrl
      } else if (mediaType === 'document') {
        normalizedMessage.document = {
          id: messageId,
          mime_type: 'application/octet-stream',
          filename: extractFilename(mediaUrl),
          caption: body,
        }
        normalizedMessage.media_url = mediaUrl
      } else if (mediaType === 'audio') {
        normalizedMessage.audio = {
          id: messageId,
          mime_type: 'audio/mpeg',
        }
        normalizedMessage.media_url = mediaUrl
      }
    }

    // Handle reply context
    if (quotedMessageId) {
      normalizedMessage.context = { id: quotedMessageId }
    }

    // Contact (uazapi doesn't provide name, so use phone as name)
  const contact = {
    profile: { name: chatId || from },
    wa_id: chatId || from,
  }

    // Decrypt instance_token for any media fetch that might be needed
    let instanceToken = ''
    try {
      instanceToken = decrypt(config.instance_token)
    } catch (err) {
      console.warn(
        '[webhook] Failed to decrypt instance_token for media fetch:',
        err
      )
    }

    // Process like Meta
    await processMessage(
      normalizedMessage,
      contact,
      accountId,
      configUserId,
      instanceToken
    )
  } catch (err) {
    console.error('[webhook] handleUazapiInboundMessage failed:', err)
  }
}

/**
 * Handle message status updates from uazapi (message.status event).
 */
async function handleUazapiMessageStatus(data: Record<string, unknown>) {
  try {
    // uazapi status structure:
    // {
    //   instanceId: "...",
    //   messageId: "true_5521999999999_...",
    //   status: "sent" | "delivered" | "read" | "error",
    //   timestamp: 1234567890
    // }

    const messageId = (data.messageId || data.messageid || data.id) as string | undefined
    const status = data.status as string | undefined
    const timestamp = data.timestamp as number | undefined

    if (!messageId || !status) {
      console.error('[webhook] uazapi status missing fields:', { messageId, status })
      return
    }

    // Map uazapi statuses to wacrm statuses
    const mappedStatus = mapUazapiStatus(status)

    // Call the existing handler
    await handleStatusUpdate({
      id: messageId,
      status: mappedStatus,
      timestamp: Math.floor((timestamp || Date.now()) / 1000).toString(),
      recipient_id: '', // uazapi doesn't provide this
    })
  } catch (err) {
    console.error('[webhook] handleUazapiMessageStatus failed:', err)
  }
}

/**
 * Map uazapi message types to WhatsApp API message types.
 */
function getUazapiMessageType(
  uazapiType: string | undefined
): string {
  switch (uazapiType) {
    case 'chat':
    case 'conversation':
      return 'text'
    case 'image':
      return 'image'
    case 'video':
      return 'video'
    case 'document':
    case 'file':
      return 'document'
    case 'audio':
    case 'voice':
      return 'audio'
    case 'sticker':
      return 'sticker'
    default:
      return 'text'
  }
}

/**
 * Map uazapi status strings to wacrm status values.
 */
function mapUazapiStatus(uazapiStatus: string): string {
  switch (uazapiStatus?.toLowerCase()) {
    case 'sent':
      return 'sent'
    case 'delivered':
      return 'delivered'
    case 'read':
      return 'read'
    case 'error':
    case 'failed':
      return 'failed'
    default:
      return 'sent'
  }
}

/**
 * Infer media type from URL or guess based on common patterns.
 */
function getMediaTypeFromUrl(url: string): 'image' | 'video' | 'document' | 'audio' | 'unknown' {
  const lower = url.toLowerCase()
  if (/\.(jpg|jpeg|png|gif|webp|bmp)$/i.test(lower)) return 'image'
  if (/\.(mp4|avi|mov|mkv|webm)$/i.test(lower)) return 'video'
  if (/\.(mp3|wav|ogg|m4a|aac)$/i.test(lower)) return 'audio'
  if (/\.(pdf|doc|docx|xls|xlsx|ppt|pptx|txt|zip|rar)$/i.test(lower)) return 'document'
  return 'unknown'
}

/**
 * Extract filename from URL (last path segment before query params).
 */
function extractFilename(url: string): string {
  try {
    const pathname = new URL(url).pathname
    const segments = pathname.split('/')
    const last = segments[segments.length - 1]
    return last || 'file'
  } catch {
    return 'file'
  }
}

async function processWebhook(body: { entry?: WhatsAppWebhookEntry[] }) {
  if (!body.entry) return

  for (const entry of body.entry) {
    for (const change of entry.changes) {
      // Template-lifecycle events (status / quality / components
      // updates from Meta) come in on a different change.field and
      // have a different value shape — route them through the
      // dedicated handler. Skip the messaging branches below so we
      // don't try to read message-shaped fields off a template event.
      if (isTemplateWebhookField(change.field)) {
        await handleTemplateWebhookChange(
          { field: change.field, value: change.value as unknown },
          supabaseAdmin(),
        )
        continue
      }

      const value = change.value

      // Handle status updates
      if (value.statuses) {
        for (const status of value.statuses) {
          await handleStatusUpdate(status)
        }
      }

      // Handle incoming messages
      if (!value.messages || !value.contacts) continue

      const phoneNumberId = value.metadata.phone_number_id

      // Find user's config by phone_number_id. `.single()` returns
      // PGRST116 for both 0 rows AND ≥2 rows — distinguish them so
      // operators see the real cause in logs. ≥2 rows shouldn't happen
      // post-migration 013 (UNIQUE constraint), but a row created
      // before the constraint, or a race, would still surface here.
      const { data: configRows, error: configError } = await supabaseAdmin()
        .from('whatsapp_config')
        .select('*')
        .eq('phone_number_id', phoneNumberId)

      if (configError) {
        console.error(
          'Error fetching whatsapp_config for phone_number_id:',
          phoneNumberId,
          configError
        )
        continue
      }

      if (!configRows || configRows.length === 0) {
        console.error('No config found for phone_number_id:', phoneNumberId)
        continue
      }

      if (configRows.length > 1) {
        console.error(
          `Multiple configs (${configRows.length}) found for phone_number_id:`,
          phoneNumberId,
          '— inbound message dropped. Resolve duplicates so each number maps to a single account.',
          'Account owners:',
          configRows.map((r: { account_id: string; user_id: string }) => `${r.account_id} (admin ${r.user_id})`)
        )
        continue
      }

      const config = configRows[0]

      const decryptedAccessToken = decrypt(config.access_token)

      for (let i = 0; i < value.messages.length; i++) {
        const message = value.messages[i]
        const contact = value.contacts[i] || value.contacts[0]

        await processMessage(
          message,
          contact,
          // Tenancy — drives every contact / conversation lookup
          // and the engines' active-row dispatch.
          config.account_id,
          // Audit / sender-of-record — used as the user_id on row
          // inserts that need it for NOT NULL FK compliance. Always
          // the admin who saved the WhatsApp config.
          config.user_id,
          decryptedAccessToken
        )
      }
    }
  }
}

// The happy-path status ladder — pending → sent → delivered → read →
// replied. Webhook replays must never regress a recipient back down
// this ladder.
//
// `failed` is NOT on this ladder. It's a terminal side branch that is
// only valid from the early states (pending / sent) — once Meta has
// delivered or the user has read or replied, a later "failed" status
// event is a bug in Meta's pipeline or a spoof attempt and must be
// ignored.
const RECIPIENT_STATUS_LADDER = [
  'pending',
  'sent',
  'delivered',
  'read',
  'replied',
] as const

function ladderLevel(s: string): number {
  const idx = (RECIPIENT_STATUS_LADDER as readonly string[]).indexOf(s)
  return idx < 0 ? -1 : idx
}

/**
 * Can a recipient transition from `current` to `incoming`?
 *   - Along the ladder, only forward moves are allowed.
 *   - `failed` is accepted only from `pending` or `sent`; it's refused
 *     once the recipient has reached any of the success states.
 */
function isValidStatusTransition(current: string, incoming: string): boolean {
  if (incoming === 'failed') {
    return current === 'pending' || current === 'sent'
  }
  if (current === 'failed') {
    return false // failed is terminal
  }
  const ci = ladderLevel(current)
  const ii = ladderLevel(incoming)
  if (ii < 0) return false // unknown incoming status
  if (ci < 0) return true // unknown current — accept anything on the ladder
  return ii > ci
}

async function handleStatusUpdate(status: {
  id: string
  status: string
  timestamp: string
  recipient_id: string
}) {
  // 1) Mirror onto messages (legacy behavior) — Meta's status values
  //    already match the CHECK constraint on messages.status. No
  //    `.select()`: message_id is NOT unique (migration 009 — Meta ids
  //    repeat across numbers), so this updates 0..N rows and must not
  //    assume a single row.
  const { error: msgErr } = await supabaseAdmin()
    .from('messages')
    .update({ status: status.status })
    .eq('message_id', status.id)

  if (msgErr) {
    console.error('Error updating message status:', msgErr)
  }

  // Webhook fan-out for this status change happens at the END of this
  // handler (after the broadcast mirror below), so a slow subscriber
  // endpoint can't delay the broadcast_recipients update.

  // 2) Mirror onto broadcast_recipients via whatsapp_message_id
  //    (added in migration 003). The aggregate trigger on
  //    broadcast_recipients re-derives the parent broadcast's
  //    sent/delivered/read/failed counts automatically.
  const tsIso = new Date(parseInt(status.timestamp) * 1000).toISOString()

  const { data: recipient, error: recFetchErr } = await supabaseAdmin()
    .from('broadcast_recipients')
    .select('id, status')
    .eq('whatsapp_message_id', status.id)
    .maybeSingle()

  if (recFetchErr) {
    console.error('Error fetching broadcast recipient:', recFetchErr)
  } else if (
    recipient &&
    // Guard transitions — forward-only on the success ladder, and
    // `failed` only from pre-delivered states.
    isValidStatusTransition(recipient.status, status.status)
  ) {
    const update: Record<string, unknown> = { status: status.status }
    if (status.status === 'sent' && !('sent_at' in update)) update.sent_at = tsIso
    if (status.status === 'delivered') update.delivered_at = tsIso
    if (status.status === 'read') update.read_at = tsIso

    const { error: recUpdateErr } = await supabaseAdmin()
      .from('broadcast_recipients')
      .update(update)
      .eq('id', recipient.id)

    if (recUpdateErr) {
      console.error('Error updating broadcast recipient status:', recUpdateErr)
    }
  }

  // 3) Webhook fan-out for messages we store (inbox / API sends).
  //    Runs last so a slow subscriber can't delay the mirrors above.
  //    Bounded to one row (message_id isn't unique) purely to resolve
  //    the owning account for delivery.
  const { data: msgRow } = await supabaseAdmin()
    .from('messages')
    .select('conversation_id, conversations(account_id)')
    .eq('message_id', status.id)
    .limit(1)
    .maybeSingle()

  if (msgRow) {
    const conv = msgRow.conversations as { account_id: string } | null
    const accountId = conv?.account_id
    if (accountId) {
      await dispatchWebhookEvent(
        supabaseAdmin(),
        accountId,
        'message.status_updated',
        {
          whatsapp_message_id: status.id,
          conversation_id: msgRow.conversation_id,
          status: status.status,
        }
      )
    }
  }
}

/**
 * If an inbound message's sender is on a still-unreplied
 * broadcast_recipients row, flip it to `replied` so the reply count
 * advances on the parent broadcast.
 *
 * Runs on a best-effort basis — failures here must not break the
 * main inbound-message flow, so errors are swallowed with a log.
 */
async function flagBroadcastReplyIfAny(accountId: string, contactId: string) {
  try {
    // Most recent outbound broadcast in this account that hasn't
    // been replied to yet. Account-scoped so a shared inbox reply
    // marks the broadcast as replied regardless of which teammate
    // sent it.
    const { data: recs, error } = await supabaseAdmin()
      .from('broadcast_recipients')
      .select('id, status, broadcast_id, broadcasts!inner(account_id)')
      .eq('contact_id', contactId)
      .eq('broadcasts.account_id', accountId)
      .in('status', ['sent', 'delivered', 'read'])
      .order('created_at', { ascending: false })
      .limit(1)

    if (error || !recs || recs.length === 0) return

    const row = recs[0]
    const { error: updErr } = await supabaseAdmin()
      .from('broadcast_recipients')
      .update({ status: 'replied', replied_at: new Date().toISOString() })
      .eq('id', row.id)

    if (updErr) {
      console.error('Error marking broadcast recipient replied:', updErr)
    }
  } catch (err) {
    console.error('flagBroadcastReplyIfAny failed:', err)
  }
}

/**
 * Resolve a Meta-side message_id into the matching internal UUID, scoped
 * to one conversation. Returns null when we never received the parent
 * (e.g. a swipe-reply to a message older than this CRM install).
 */
async function lookupInternalIdByMetaId(
  metaId: string,
  conversationId: string
): Promise<string | null> {
  const { data, error } = await supabaseAdmin()
    .from('messages')
    .select('id')
    .eq('message_id', metaId)
    .eq('conversation_id', conversationId)
    .maybeSingle()
  if (error) {
    console.error('[webhook] lookupInternalIdByMetaId failed:', error.message)
    return null
  }
  return data?.id ?? null
}

/**
 * Persist an inbound reaction. WhatsApp reactions are not new messages —
 * they're per-(target, actor) state. We upsert / delete on
 * `message_reactions`, never write a row into `messages`.
 *
 * Best-effort: a missing parent (we never received it) is logged and
 * skipped so the webhook still acks 200 to Meta.
 */
async function handleReaction(
  message: WhatsAppMessage,
  conversationId: string,
  contactId: string
) {
  const reaction = message.reaction
  if (!reaction?.message_id) return

  const targetInternalId = await lookupInternalIdByMetaId(
    reaction.message_id,
    conversationId
  )
  if (!targetInternalId) {
    console.warn(
      '[webhook] reaction target message not found; skipping',
      reaction.message_id
    )
    return
  }

  // Empty emoji = removal (per Meta's Cloud API spec).
  if (!reaction.emoji) {
    const { error: delError } = await supabaseAdmin()
      .from('message_reactions')
      .delete()
      .eq('message_id', targetInternalId)
      .eq('actor_type', 'customer')
      .eq('actor_id', contactId)
    if (delError) {
      console.error('[webhook] reaction delete failed:', delError.message)
    }
    return
  }

  const { error: upsertError } = await supabaseAdmin()
    .from('message_reactions')
    .upsert(
      {
        message_id: targetInternalId,
        conversation_id: conversationId,
        actor_type: 'customer',
        actor_id: contactId,
        emoji: reaction.emoji,
      },
      { onConflict: 'message_id,actor_type,actor_id' }
    )
  if (upsertError) {
    console.error('[webhook] reaction upsert failed:', upsertError.message)
  }
}

async function processMessage(
  message: WhatsAppMessage,
  contact: { profile: { name: string }; wa_id: string },
  // Tenancy. Resolved from the matched whatsapp_config row; every
  // contact / conversation / message row created downstream is
  // stamped with this so any member of the account can see it.
  accountId: string,
  // Sender-of-record for inserts that need a NOT NULL user_id FK
  // (contacts, conversations). Always the admin who saved the
  // WhatsApp config; the choice is arbitrary post-017 but stable.
  configOwnerUserId: string,
  accessToken: string
) {
  const senderPhone = normalizePhone(message.from)
  // Provider profile names are untrusted display hints. CRM names come from
  // manual entry or from the customer's explicit answer captured by the AI.
  const contactOutcome = await findOrCreateContact(
    accountId,
    configOwnerUserId,
    senderPhone
  )
  if (!contactOutcome) return
  const contactRecord = contactOutcome.contact

  // Find or create conversation
  const convResult = await findOrCreateConversation(
    accountId,
    configOwnerUserId,
    contactRecord.id
  )
  if (!convResult) return
  const conversation = convResult.conversation

  // Emit conversation.created as soon as the thread is opened — BEFORE
  // the reaction short-circuit below — so a conversation first opened by
  // a reaction still fires the event, and a subscriber always sees the
  // thread open before its first message.received.
  if (convResult.created) {
    await dispatchWebhookEvent(supabaseAdmin(), accountId, 'conversation.created', {
      conversation_id: conversation.id,
      contact_id: contactRecord.id,
    })
    try {
      await ensureLeadDealForConversation(supabaseAdmin(), {
        accountId,
        userId: configOwnerUserId,
        contactId: contactRecord.id,
        conversationId: conversation.id,
        contactName: contactRecord.name,
        contactPhone: contactRecord.phone,
      })
    } catch (err) {
      console.error('[pipeline] failed to create New Lead deal:', err)
    }
  }

  // Reactions short-circuit here — they aren't messages. We never insert
  // into `messages`, never bump unread_count, never update last_message_text.
  // Done before parseMessageContent so the media-URL fetch is skipped.
  if (message.type === 'reaction') {
    await handleReaction(message, conversation.id, contactRecord.id)
    return
  }

  // Parse message content based on type
  const { contentText, mediaUrl, mediaType, interactiveReplyId } =
    await parseMessageContent(message, accessToken)

  // Resolve swipe-reply context if present. A missing parent is fine —
  // we just store NULL and the UI renders the message without a quote.
  let replyToInternalId: string | null = null
  if (message.context?.id) {
    replyToInternalId = await lookupInternalIdByMetaId(
      message.context.id,
      conversation.id
    )
    if (!replyToInternalId) {
      console.warn(
        '[webhook] reply context parent not found:',
        message.context.id
      )
    }
  }

  // Insert message — field names MUST match the messages table schema
  // (see supabase/migrations/001_initial_schema.sql):
  //   conversation_id, sender_type, content_type, content_text,
  //   media_url, template_name, message_id, status, created_at
  // `mediaType` is intentionally unused — the schema has no media_type
  // column; the MIME type is only used to construct the proxy URL during
  // parseMessageContent. Silence the unused-var warning:
  void mediaType

  // The messages.content_type CHECK constraint (widened in migration 010
  // to add 'interactive' for button/list taps) allows:
  //   text, image, document, audio, video, location, template, interactive
  // Map incoming WhatsApp types that aren't in that list to the closest
  // allowed value so the INSERT doesn't fail with a constraint error.
  const ALLOWED_CONTENT_TYPES = new Set([
    'text', 'image', 'document', 'audio', 'video',
    'location', 'template', 'interactive',
  ])
  const contentType = ALLOWED_CONTENT_TYPES.has(message.type)
    ? message.type
    : message.type === 'sticker'
      ? 'image'   // stickers are images
      : 'text'    // reaction, unknown → text fallback

  // Determine whether this is the contact's very first inbound message
  // BEFORE we insert, so the count is accurate. Covers the case where
  // the contact row already exists (manual add / CSV import) but they've
  // never messaged us before — which new_contact_created wouldn't catch.
  const { count: priorCustomerMsgCount } = await supabaseAdmin()
    .from('messages')
    .select('id', { count: 'exact', head: true })
    .eq('conversation_id', conversation.id)
    .eq('sender_type', 'customer')
  const isFirstInboundMessage = (priorCustomerMsgCount ?? 0) === 0

  const { error: msgError } = await supabaseAdmin().from('messages').insert({
    conversation_id: conversation.id,
    sender_type: 'customer',
    content_type: contentType,
    content_text: contentText,
    media_url: mediaUrl,
    message_id: message.id,
    status: 'delivered',
    created_at: new Date(parseInt(message.timestamp) * 1000).toISOString(),
    reply_to_message_id: replyToInternalId,
    // Only populated for content_type='interactive'. Migration 010 added
    // the column; null for every other content_type so existing inserts
    // behave identically.
    interactive_reply_id: interactiveReplyId,
  })

  if (msgError) {
    console.error('Error inserting message:', msgError)
    return
  }

  // Update conversation
  const { error: convError } = await supabaseAdmin()
    .from('conversations')
    .update({
      last_message_text: contentText || `[${message.type}]`,
      last_message_at: new Date().toISOString(),
      unread_count: (conversation.unread_count || 0) + 1,
      updated_at: new Date().toISOString(),
    })
    .eq('id', conversation.id)

  if (convError) {
    console.error('Error updating conversation:', convError)
  }

  // If this contact was a recent broadcast recipient, flag the reply
  // so the broadcast's `replied_count` advances (via the aggregate
  // trigger installed in migration 003).
  await flagBroadcastReplyIfAny(accountId, contactRecord.id)

  // ============================================================
  // Flow runner dispatch.
  //
  // If the runner consumes the message (it either advanced an active
  // run or started a new one), we suppress the `new_message_received`
  // + `keyword_match` automation triggers for this inbound. Customer
  // is navigating the bot menu, not sending a fresh trigger word
  // that should fork into automations.
  //
  // The relationship-level triggers (`new_contact_created`,
  // `first_inbound_message`) still fire even when consumed — those
  // are about WHO is messaging, not what they said.
  //
  // Awaited (not fire-and-forget) because we need the `consumed`
  // result before deciding whether to dispatch automations. The
  // runner has its own try/catch and never throws. Accounts with
  // no active flows take the runner's early-exit "no_match" path
  // basically for free (one indexed SELECT for the active run).
  // ============================================================
  const flowResult = await dispatchInboundToFlows({
    accountId,
    userId: configOwnerUserId,
    contactId: contactRecord.id,
    conversationId: conversation.id,
    message:
      interactiveReplyId
        ? {
            kind: 'interactive_reply',
            reply_id: interactiveReplyId,
            reply_title: contentText ?? '',
            meta_message_id: message.id,
          }
        : {
            kind: 'text',
            text: contentText ?? message.text?.body ?? '',
            meta_message_id: message.id,
          },
    isFirstInboundMessage,
  })
  const flowConsumed = flowResult.consumed

  // Fire any automations that react to this webhook event. All dispatches
  // run here (not earlier) so the contact, conversation, and inbound
  // message all exist before any step — including send_message — runs.
  // Fire-and-forget: a slow or failing automation must not block the
  // webhook's 200 OK response to Meta.
  const inboundText = contentText ?? message.text?.body ?? ''
  const automationTriggers: (
    | 'new_contact_created'
    | 'first_inbound_message'
    | 'new_message_received'
    | 'keyword_match'
    | 'interactive_reply'
  )[] = []
  // Content-level triggers are suppressed when a flow consumed the
  // message — see the comment block above.
  if (!flowConsumed) {
    automationTriggers.push('new_message_received', 'keyword_match')
    // Interactive tap → fire the interactive_reply trigger too (only
    // meaningful when a button/list reply actually arrived). Enables
    // automation-only chained menus; when a Flow owns the menu it will
    // have consumed the reply and this is skipped.
    if (interactiveReplyId) {
      automationTriggers.push('interactive_reply')
    }
  }
  // new_contact_created fires only when the webhook just auto-created the
  // contact row. first_inbound_message fires whenever this is the contact's
  // first-ever customer-sent message — a superset that also catches
  // manually-imported contacts sending for the first time. We dispatch both
  // so users can pick whichever semantic they want; an automation that
  // listens to only one trigger runs only when that trigger matches.
  if (contactOutcome.wasCreated) automationTriggers.unshift('new_contact_created')
  if (isFirstInboundMessage) automationTriggers.unshift('first_inbound_message')
  for (const triggerType of automationTriggers) {
    runAutomationsForTrigger({
      accountId,
      triggerType,
      contactId: contactRecord.id,
      context: {
        message_text: inboundText,
        conversation_id: conversation.id,
        // Only set on interactive taps; drives the interactive_reply
        // trigger's exact-id match.
        interactive_reply_id: interactiveReplyId ?? undefined,
      },
    }).catch((err) => console.error('[automations] dispatch failed:', err))
  }

  // AI auto-reply. Runs only for plain-text inbound the deterministic
  // flow runner did NOT consume (flows win over the LLM), and only when
  // the account has enabled it. Awaited inside `after()` (same reason as
  // the webhook dispatch below); `dispatchInboundToAiReply` owns its
  // eligibility gates + try/catch and never throws.
  if (!flowConsumed && !interactiveReplyId && inboundText.trim()) {
    await dispatchInboundToAiReply({
      accountId,
      conversationId: conversation.id,
      contactId: contactRecord.id,
      configOwnerUserId,
    })
  }

  // message.received webhook (public API). Awaited — not fire-and-forget
  // — because we're inside the route's `after()` block, which only keeps
  // the function alive for promises it can see; a detached promise could
  // be frozen before it delivers. `dispatchWebhookEvent` early-exits
  // when the account has no matching endpoint and never throws.
  // (conversation.created is emitted earlier, right after the thread is
  // opened.)
  await dispatchWebhookEvent(supabaseAdmin(), accountId, 'message.received', {
    conversation_id: conversation.id,
    contact_id: contactRecord.id,
    whatsapp_message_id: message.id,
    content_type: contentType,
    text: contentText,
  })
}

async function parseMessageContent(
  message: WhatsAppMessage,
  accessToken: string
): Promise<{
  contentText: string | null
  mediaUrl: string | null
  mediaType: string | null
  /**
   * For interactive button / list replies: the stable id of the tapped
   * option (whatever we put on the button when sending). Used by the
   * Flows engine to advance the per-contact run; persisted to
   * `messages.interactive_reply_id` so the inbox bubble can render the
   * tap with the right affordance. Null for everything else.
   */
  interactiveReplyId: string | null
}> {
  // getMediaUrl signature is (mediaId, accessToken) — earlier code had
  // the args swapped, so every verification hit an invalid Meta URL and
  // fell through to the catch block, leaving mediaUrl as null. That's
  // why images showed up as empty bubbles in the inbox.
  const verifyAndBuildUrl = async (
    mediaId: string
  ): Promise<string | null> => {
    if (message.media_url) return message.media_url
    try {
      await getMediaUrl({ mediaId, accessToken })
      return `/api/whatsapp/media/${mediaId}`
    } catch (error) {
      console.error(
        `Failed to verify media ${mediaId} with Meta:`,
        error instanceof Error ? error.message : error
      )
      return null
    }
  }

  // Default shape — each case overrides only the fields it cares about.
  // Keeps the new `interactiveReplyId` field DRY across every return site.
  const empty = {
    contentText: null,
    mediaUrl: null,
    mediaType: null,
    interactiveReplyId: null,
  }

  switch (message.type) {
    case 'text':
      return { ...empty, contentText: message.text?.body || null }

    case 'image':
      if (message.image?.id) {
        return {
          ...empty,
          contentText: message.image.caption || null,
          mediaUrl: await verifyAndBuildUrl(message.image.id),
          mediaType: message.image.mime_type,
        }
      }
      return empty

    case 'video':
      if (message.video?.id) {
        return {
          ...empty,
          contentText: message.video.caption || null,
          mediaUrl: await verifyAndBuildUrl(message.video.id),
          mediaType: message.video.mime_type,
        }
      }
      return empty

    case 'document':
      if (message.document?.id) {
        return {
          ...empty,
          contentText:
            message.document.caption || message.document.filename || null,
          mediaUrl: await verifyAndBuildUrl(message.document.id),
          mediaType: message.document.mime_type,
        }
      }
      return empty

    case 'audio':
      if (message.audio?.id) {
        return {
          ...empty,
          mediaUrl: await verifyAndBuildUrl(message.audio.id),
          mediaType: message.audio.mime_type,
        }
      }
      return empty

    case 'sticker':
      // Stickers are images under the hood. Treat them as such so the
      // MessageBubble renders the <img>. The caller maps the DB
      // content_type to 'image' for the CHECK constraint.
      if (message.sticker?.id) {
        return {
          ...empty,
          mediaUrl: await verifyAndBuildUrl(message.sticker.id),
          mediaType: message.sticker.mime_type,
        }
      }
      return empty

    case 'location':
      if (message.location) {
        const loc = message.location
        const locationText = [loc.name, loc.address, `${loc.latitude},${loc.longitude}`]
          .filter(Boolean)
          .join(' - ')
        return { ...empty, contentText: locationText }
      }
      return empty

    case 'reaction':
      return { ...empty, contentText: message.reaction?.emoji || null }

    case 'interactive': {
      // The customer tapped a reply button or a list row on a message
      // we previously sent. Meta delivers `interactive.button_reply` for
      // 3-button messages and `interactive.list_reply` for list messages.
      // Use the human-readable title as contentText so the inbox bubble
      // renders the tap legibly ("Existing customer"), and stash the
      // stable id separately so the Flows engine can route on it.
      const reply =
        message.interactive?.button_reply ?? message.interactive?.list_reply
      if (reply?.id) {
        return {
          ...empty,
          contentText: reply.title || reply.id,
          interactiveReplyId: reply.id,
        }
      }
      return { ...empty, contentText: '[Interactive reply]' }
    }

    default:
      return {
        ...empty,
        contentText: `[Unsupported message type: ${message.type}]`,
      }
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ContactRow = any

interface ContactOutcome {
  contact: ContactRow
  /** True when this call created the row; drives new_contact_created
   *  automation dispatch in processMessage. */
  wasCreated: boolean
}

async function findOrCreateContact(
  accountId: string,
  configOwnerUserId: string,
  phone: string
): Promise<ContactOutcome | null> {
  // Find an existing contact for this account by phone. The shared
  // helper pre-filters in SQL by the last-8-digit suffix (so we don't
  // pull every contact on every inbound message) then applies the
  // strict `phonesMatch` in JS on the small candidate set. The same
  // helper backs the manual contact form and CSV import, so all three
  // paths agree on what "same number" means (issue #212).
  const existingContact = await findExistingContact(
    supabaseAdmin(),
    accountId,
    phone,
  )

  if (existingContact) {
    return { contact: existingContact, wasCreated: false }
  }

  // Create new contact. account_id is the tenancy column;
  // user_id is the NOT NULL FK audit column (no inbound message
  // has a single "user who created" it — we attribute to the
  // WhatsApp config owner as a stable default).
  const { data: newContact, error: createError } = await supabaseAdmin()
    .from('contacts')
    .insert({
      account_id: accountId,
      user_id: configOwnerUserId,
      phone,
      name: phone,
    })
    .select()
    .single()

  if (createError) {
    // Lost a race: a concurrent inbound delivery (or another path)
    // created this contact between our lookup and insert, and the
    // unique index (migration 022) rejected the duplicate. Re-resolve
    // the existing row instead of dropping the message.
    if (isUniqueViolation(createError)) {
      const raced = await findExistingContact(supabaseAdmin(), accountId, phone)
      if (raced) return { contact: raced, wasCreated: false }
    }
    console.error('Error creating contact:', createError)
    return null
  }

  return { contact: newContact, wasCreated: true }
}

async function findOrCreateConversation(
  accountId: string,
  configOwnerUserId: string,
  contactId: string,
) {
  // Look for existing conversation in this account
  const { data: existing, error: findError } = await supabaseAdmin()
    .from('conversations')
    .select('*')
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    .single()

  if (!findError && existing) {
    return { conversation: existing, created: false }
  }

  // Create new conversation. Same tenancy + audit split as
  // findOrCreateContact above.
  const { data: newConv, error: createError } = await supabaseAdmin()
    .from('conversations')
    .insert({
      account_id: accountId,
      user_id: configOwnerUserId,
      contact_id: contactId,
    })
    .select()
    .single()

  if (createError) {
    console.error('Error creating conversation:', createError)
    return null
  }

  return { conversation: newConv, created: true }
}

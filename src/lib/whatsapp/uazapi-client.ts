/**
 * uazapi WhatsApp Integration Client
 *
 * Alternative to Meta's official WhatsApp Cloud API using uazapi (non-official).
 * Each WhatsApp number is represented as an instance with its own token.
 *
 * Docs: https://docs.uazapi.com/
 * Base URL: https://eluminaai.uazapi.com
 *
 * Authentication:
 *   - Admin operations: Use UAZAPI_ADMIN_TOKEN header
 *   - Regular operations: Use instance token (obtained from connectInstance)
 *   - Webhook: Validate using UAZAPI_WEBHOOK_TOKEN header
 */

const DEFAULT_UAZAPI_BASE_URL = process.env.UAZAPI_BASE_URL || 'https://eluminaai.uazapi.com'

function uazapiUrl(path: string, baseUrl = DEFAULT_UAZAPI_BASE_URL) {
  return `${baseUrl.replace(/\/$/, '')}${path}`
}
const UAZAPI_ADMIN_TOKEN = process.env.UAZAPI_ADMIN_TOKEN

export interface UazapiErrorResponse {
  error?: {
    message?: string
    code?: number
    status?: number
  }
  message?: string
}

/**
 * Throw a structured error from uazapi response
 */
async function throwUazapiError(
  response: Response,
  fallback: string
): Promise<never> {
  let message = fallback

  try {
    const raw = await response.text()

    console.error('[UAZAPI RAW ERROR]', raw)

    try {
      const data = JSON.parse(raw)

      if (data.error?.message) {
        message = data.error.message
      } else if (data.message) {
        message = data.message
      } else if (raw) {
        message = raw
      }

    } catch {
      if (raw) {
        message = raw
      }
    }

  } catch {}

  throw new Error(`uazapi error: ${message}`)
}

/**
 * Ensure admin token is configured
 */
function requireAdminToken(): string {
  if (!UAZAPI_ADMIN_TOKEN) {
    throw new Error('UAZAPI_ADMIN_TOKEN environment variable is required')
  }
  return UAZAPI_ADMIN_TOKEN
}

// ============================================================
// Instance Connection (QR Code / Pairing Code)
// ============================================================

export interface ConnectInstanceArgs {
  /**
   * Phone number for pairing code mode (optional).
   * Format: 5511999999999 (without +)
   * If omitted, returns QR code instead.
   */
  phone?: string
}

export interface ConnectInstanceResult {
  /**
   * Base64-encoded PNG image of the QR code (if phone not provided).
   * Format: "data:image/png;base64,iVBORw0KG..."
   */
  qrcode?: string

  /**
   * Pairing code (if phone provided).
   * User enters this in WhatsApp → Link Device → Link with Phone Number
   * Format: "111-222" (6 digits with hyphen)
   */
  pairingCode?: string

  /**
   * Unique identifier for this instance. Store this to find the
   * instance later if needed.
   */
  instanceId?: string

  /**
   * The auth token for this instance. Store encrypted in the database.
   * Use in subsequent requests via 'token' header.
   */
  instanceToken?: string

  success: boolean
  message?: string
}

/**
 * Initiate WhatsApp connection via QR code or pairing code.
 * QR code expires in 2 minutes, pairing code in 5 minutes.
 *
 * Call without phone to get QR code (scan in WhatsApp app).
 * Call with phone to get pairing code (user enters manually).
 */
export async function connectInstance(
  args: ConnectInstanceArgs = {}
): Promise<ConnectInstanceResult> {
  const adminToken = requireAdminToken()
  const { phone } = args

  const url = uazapiUrl('/instance/connect')
  const body: Record<string, unknown> = {}

  if (phone) {
    body.phone = phone
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      token: adminToken,
    },
    body: JSON.stringify(body),
  })

  if (!response.ok) {
    await throwUazapiError(response, `Failed to connect instance: ${response.status}`)
  }

  const data = (await response.json()) as ConnectInstanceResult & {
    qr_code?: string
    instance_id?: string
    instance_token?: string
  }

  return {
    qrcode: data.qrcode || data.qr_code,
    pairingCode: data.pairingCode,
    instanceId: data.instanceId || data.instance_id,
    instanceToken: data.instanceToken || data.instance_token,
    success: data.success !== false,
    message: data.message,
  }
}

// ============================================================
// Instance Status
// ============================================================

export type InstanceState = 'disconnected' | 'connecting' | 'connected' | 'hibernated'

export interface GetInstanceStatusArgs {
  /**
   * The instance token returned from connectInstance or stored in the database.
   */
  baseUrl?: string

  instanceToken: string
}

export interface GetInstanceStatusResult {
  state: InstanceState
  phone?: string
  connected: boolean
  instanceId?: string
  name?: string
  createdAt?: string
  lastActivity?: string
}

/**
 * Check the current status of a WhatsApp instance.
 */
export async function getInstanceStatus(
  args: GetInstanceStatusArgs
): Promise<GetInstanceStatusResult> {
  const { baseUrl, instanceToken } = args
  const url = uazapiUrl('/instance/status', baseUrl)

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      token: instanceToken,
    },
  })

  if (!response.ok) {
    await throwUazapiError(response, `Failed to get instance status: ${response.status}`)
  }

  const data = (await response.json()) as {
    state?: InstanceState
    status?: InstanceState | { connected?: boolean; loggedIn?: boolean }
    phone?: string
    connected?: boolean
    created_at?: string
    last_activity?: string
    instance?: {
      id?: string
      status?: InstanceState
      connected?: boolean
      owner?: string
      profileName?: string
      name?: string
      created_at?: string
      last_activity?: string
    }
  }
  const instance = data.instance
  const rootStatus = data.status
  const rootConnected = typeof rootStatus === 'object' ? rootStatus.connected ?? rootStatus.loggedIn : undefined
  const state = data.state || instance?.status || (typeof rootStatus === 'string' ? rootStatus : rootConnected ? 'connected' : 'disconnected')

  return {
    state,
    phone: data.phone || instance?.owner,
    connected: data.connected ?? instance?.connected ?? rootConnected ?? state === 'connected',
    instanceId: instance?.id,
    name: instance?.profileName || instance?.name,
    createdAt: data.created_at || instance?.created_at,
    lastActivity: data.last_activity || instance?.last_activity,
  }
}

// ============================================================
// Send Messages
// ============================================================

export interface SendTextMessageArgs {
  baseUrl?: string
  /**
   * The instance token.
   */
  instanceToken: string

  /**
   * Recipient phone number (format: 5511999999999 without +)
   * or group ID (format: 120363...@g.us)
   */
  to: string

  /**
   * Message text. Supports placeholders:
   *   {{name}}, {{first_name}}, {{lead_email}}, {{lead_status}},
   *   {{lead_field01}} through {{lead_field20}}
   */
  text: string

  /**
   * Delay in milliseconds before sending (shows "typing..." state).
   * Useful for simulating human behavior. Max ~5000ms recommended.
   */
  delay?: number

  /**
   * Message ID to reply to (creates a reply context with quote).
   */
  replyid?: string

  /**
   * Track source for analytics (e.g., "crm", "automation", "api").
   */
  track_source?: string

  /**
   * Your internal message tracking ID for correlation.
   */
  track_id?: string

  /**
   * If true, marks the conversation as read when sending.
   */
  readchat?: boolean

  /**
   * If true, marks all previous messages as read.
   */
  readmessages?: boolean

  /**
   * If true, uses async mode (returns 200 when queued, not when sent).
   * Useful for high-volume sends, but delivery isn't guaranteed immediately.
   */
  async?: boolean
}

export interface SendMessageResult {
  /**
   * Unique message ID from uazapi.
   */
  messageid: string

  /**
   * Send status: 'sent' (immediate), 'queued' (async), etc.
   */
  status?: 'sent' | 'queued' | 'pending'
}

/**
 * Send a text message via WhatsApp.
 * Works within the 24-hour customer service window (no limit if customer
 * sent a message first). Messages with placeholders require field matching.
 */
export async function sendTextMessage(
  args: SendTextMessageArgs
): Promise<SendMessageResult> {
  const {
    baseUrl,
    instanceToken,
    to,
    text,
    delay,
    replyid,
    track_source,
    track_id,
    readchat,
    readmessages,
    async: asyncMode,
  } = args

  const url = uazapiUrl('/send/text', baseUrl)
  const body: Record<string, unknown> = {
    to,
    text,
  }

  if (delay !== undefined) body.delay = delay
  if (replyid) body.replyid = replyid
  if (track_source) body.track_source = track_source
  if (track_id) body.track_id = track_id
  if (readchat) body.readchat = readchat
  if (readmessages) body.readmessages = readmessages
  if (asyncMode) body.async = asyncMode

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      token: instanceToken,
    },
    body: JSON.stringify(body),
  })

  if (!response.ok) {
    await throwUazapiError(response, `Failed to send text message: ${response.status}`)
  }

  const data = (await response.json()) as SendMessageResult & {
    message_id?: string
  }

  return {
    messageid: data.messageid || data.message_id || '',
    status: data.status,
  }
}

// ============================================================
// Send Media
// ============================================================

export type MediaKind = 'image' | 'video' | 'document' | 'audio'

export interface SendMediaMessageArgs {
  baseUrl?: string
  instanceToken: string
  to: string

  /**
   * Media type.
   */
  kind: MediaKind

  /**
   * Public URL that uazapi will fetch. Must be accessible from the internet.
   * Supported formats:
   *   - image: JPG, PNG, WebP, GIF
   *   - video: MP4, 3GP
   *   - document: PDF, DOC, DOCX, XLS, XLSX, PPT, PPTX, TXT
   *   - audio: AAC, M4A, MP3, OGG
   */
  link: string

  /**
   * Optional filename for documents (shown in WhatsApp).
   */
  filename?: string

  /**
   * Optional caption/description (shown below media).
   */
  caption?: string

  delay?: number
  replyid?: string
  track_source?: string
  track_id?: string
  readchat?: boolean
  readmessages?: boolean
  async?: boolean
}

/**
 * Send an image, video, document, or audio file via WhatsApp.
 */
export async function sendMediaMessage(
  args: SendMediaMessageArgs
): Promise<SendMessageResult> {
  const {
    baseUrl,
    instanceToken,
    to,
    kind,
    link,
    filename,
    caption,
    delay,
    replyid,
    track_source,
    track_id,
    readchat,
    readmessages,
    async: asyncMode,
  } = args

  const url = uazapiUrl(`/send/${kind}`, baseUrl)
  const body: Record<string, unknown> = {
    to,
    link,
  }

  if (filename) body.filename = filename
  if (caption) body.caption = caption
  if (delay !== undefined) body.delay = delay
  if (replyid) body.replyid = replyid
  if (track_source) body.track_source = track_source
  if (track_id) body.track_id = track_id
  if (readchat) body.readchat = readchat
  if (readmessages) body.readmessages = readmessages
  if (asyncMode) body.async = asyncMode

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      token: instanceToken,
    },
    body: JSON.stringify(body),
  })

  if (!response.ok) {
    await throwUazapiError(response, `Failed to send ${kind} message: ${response.status}`)
  }

  const data = (await response.json()) as SendMessageResult & {
    message_id?: string
  }

  return {
    messageid: data.messageid || data.message_id || '',
    status: data.status,
  }
}

// ============================================================
// Webhook Configuration
// ============================================================

export interface SetWebhookArgs {
  /**
   * Your webhook URL (must be publicly accessible over HTTPS).
   * uazapi will POST events to this URL.
   * Example: https://your-crm.vercel.app/api/whatsapp/webhook
   */
  url: string

  /**
   * Authorization header value that uazapi will send with each webhook.
   * Typically: "Bearer YOUR_WEBHOOK_TOKEN"
   * You'll validate this in your webhook handler.
   */
  authHeader: string
}

/**
 * Configure the webhook URL where uazapi will deliver events
 * (incoming messages, status updates, etc).
 *
 * After calling this, uazapi will POST events to your URL with:
 *   Authorization: <authHeader>
 *
 * Event types:
 *   - messages.new: New incoming message
 *   - message.status: Message delivery/read status update
 */
export async function setWebhook(args: SetWebhookArgs): Promise<void> {
  const adminToken = requireAdminToken()
  const { url, authHeader } = args

  const urlEndpoint = uazapiUrl('/webhook')
  const body = {
    url,
    auth_header: authHeader,
  }

  const response = await fetch(urlEndpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      token: adminToken,
    },
    body: JSON.stringify(body),
  })

  if (!response.ok) {
    await throwUazapiError(response, `Failed to set webhook: ${response.status}`)
  }
}

/**
 * Get current webhook configuration.
 */
export async function getWebhook(): Promise<{
  url?: string
  authHeader?: string
  createdAt?: string
}> {
  const adminToken = requireAdminToken()
  const url = uazapiUrl('/webhook')

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      token: adminToken,
    },
  })

  if (!response.ok) {
    await throwUazapiError(response, `Failed to get webhook: ${response.status}`)
  }

  const data = (await response.json()) as {
    url?: string
    auth_header?: string
    created_at?: string
  }

  return {
    url: data.url,
    authHeader: data.auth_header,
    createdAt: data.created_at,
  }
}

// ============================================================
// Instance Disconnect
// ============================================================

export interface DisconnectInstanceArgs {
  instanceToken: string
}

/**
 * Disconnect a WhatsApp instance. The instance enters 'hibernated' state.
 * Credentials are preserved, so you can reconnect later.
 */
export async function disconnectInstance(
  args: DisconnectInstanceArgs
): Promise<void> {
  const { instanceToken } = args
  const url = uazapiUrl('/instance/disconnect')

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      token: instanceToken,
    },
  })

  if (!response.ok) {
    await throwUazapiError(response, `Failed to disconnect instance: ${response.status}`)
  }
}

/**
 * Delete a WhatsApp instance permanently. Cannot be undone.
 */
export async function deleteInstance(
  args: DisconnectInstanceArgs
): Promise<void> {
  const { instanceToken } = args
  const url = uazapiUrl('/instance')

  const response = await fetch(url, {
    method: 'DELETE',
    headers: {
      token: instanceToken,
    },
  })

  if (!response.ok) {
    await throwUazapiError(response, `Failed to delete instance: ${response.status}`)
  }
}

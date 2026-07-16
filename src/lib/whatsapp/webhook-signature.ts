import crypto from 'node:crypto'

/**
 * Verify the HMAC-SHA256 signature Meta attaches to webhook POSTs.
 *
 * Meta signs the raw request body with your App Secret and sends the
 * result in the `x-hub-signature-256: sha256=<hex>` header. Without
 * verification, anyone who knows our webhook URL can POST fabricated
 * status updates and drift broadcast counts arbitrarily.
 *
 * Reference:
 *   https://developers.facebook.com/docs/graph-api/webhooks/getting-started#verify-payloads
 *
 * Contract:
 *   `META_APP_SECRET` is **required**. If it's missing we fail closed —
 *   every request is rejected until the operator configures the
 *   secret. A previous version fell open with a warning log, which is
 *   unsafe for a public template: anyone who forgets the env var would
 *   be running a fully spoofable webhook.
 */
export function verifyMetaWebhookSignature(
  rawBody: string,
  signatureHeader: string | null,
): boolean {
  const secret = process.env.META_APP_SECRET
  if (!secret) {
    console.error(
      '[webhook] META_APP_SECRET is not set — rejecting request. ' +
        'Configure the env var (Meta → App Settings → Basic → App Secret) ' +
        'to enable signature verification.',
    )
    return false
  }

  if (!signatureHeader) return false
  if (!signatureHeader.startsWith('sha256=')) return false

  const expected =
    'sha256=' +
    crypto.createHmac('sha256', secret).update(rawBody).digest('hex')

  const a = Buffer.from(signatureHeader)
  const b = Buffer.from(expected)
  // Bail if lengths differ — timingSafeEqual throws otherwise.
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}

/**
 * Verify the token UAZAPI sends with webhook POSTs.
 *
 * UAZAPI's dashboard does not support custom headers, so production uses a
 * secret URL query parameter: /api/whatsapp/webhook?uazapi_token=<token>.
 * Keep Authorization support for API-created webhooks.
 *
 * Contract:
 *   `UAZAPI_WEBHOOK_TOKEN` is **required**. If it's missing we fail closed -
 *   every request is rejected until the operator configures the token.
 */
export function verifyUazapiWebhookSignature(
  authorizationHeader: string | null,
  urlToken?: string | null,
): boolean {
  const token = process.env.UAZAPI_WEBHOOK_TOKEN
  if (!token) {
    console.error(
      '[webhook] UAZAPI_WEBHOOK_TOKEN is not set - rejecting request. ' +
        'Configure the env var to enable webhook verification.',
    )
    return false
  }

  const provided = authorizationHeader?.startsWith('Bearer ')
    ? authorizationHeader.slice('Bearer '.length)
    : urlToken

  if (!provided) return false

  const a = Buffer.from(provided)
  const b = Buffer.from(token)
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}

export function verifyEvolutionWebhookSignature(
  providedToken: string | null,
  expectedToken: string,
): boolean {
  if (!providedToken || !expectedToken) return false
  const provided = Buffer.from(providedToken)
  const expected = Buffer.from(expectedToken)
  if (provided.length !== expected.length) return false
  return crypto.timingSafeEqual(provided, expected)
}
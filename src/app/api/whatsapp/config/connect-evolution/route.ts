import { createHash, randomBytes } from 'node:crypto'
import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { decrypt, encrypt } from '@/lib/whatsapp/encryption'
import {
  connectEvolutionInstance,
  EvolutionRequestError,
  createEvolutionInstance,
  getEvolutionConnectionState,
  isEvolutionConnected,
  normalizeEvolutionBaseUrl,
  setEvolutionWebhook,
  type EvolutionVariant,
} from '@/lib/whatsapp/evolution-client'

const INSTANCE_NAME = /^[A-Za-z0-9_-]{2,64}$/

export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('admin')
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
    if (!body) {
      return NextResponse.json({ error: 'Corpo da requisição inválido.' }, { status: 400 })
    }

    const { data: existing } = await supabase
      .from('whatsapp_config')
      .select('id, provider, phone_number_id, access_token, instance_id, evolution_base_url, evolution_instance_name, evolution_webhook_secret')
      .eq('account_id', accountId)
      .maybeSingle()

    let baseUrl: string
    try {
      baseUrl = normalizeEvolutionBaseUrl(
        String(body.baseUrl || existing?.evolution_base_url || ''),
      )
    } catch (error) {
      return NextResponse.json(
        { error: error instanceof Error ? error.message : 'URL inválida.' },
        { status: 400 },
      )
    }

    const instanceName = String(
      body.instanceName || existing?.evolution_instance_name || '',
    ).trim()
    if (!INSTANCE_NAME.test(instanceName)) {
      return NextResponse.json(
        { error: 'Use de 2 a 64 letras, números, hífen ou underline no nome da instância.' },
        { status: 400 },
      )
    }

    let apiKey = String(body.apiKey || '').trim()
    if (!apiKey && existing?.provider === 'evolution' && existing.access_token) {
      apiKey = decrypt(existing.access_token)
    }
    if (!apiKey) {
      return NextResponse.json({ error: 'Informe a API Key da Evolution.' }, { status: 400 })
    }

    const { data: claimed } = await supabaseAdmin()
      .from('whatsapp_config')
      .select('account_id')
      .eq('provider', 'evolution')
      .eq('evolution_base_url', baseUrl)
      .eq('evolution_instance_name', instanceName)
      .neq('account_id', accountId)
      .maybeSingle()
    if (claimed) {
      return NextResponse.json(
        { error: 'Esta instância Evolution já está vinculada a outra conta.' },
        { status: 409 },
      )
    }

    const sameInstance =
      existing?.provider === 'evolution' &&
      existing.evolution_base_url === baseUrl &&
      existing.evolution_instance_name === instanceName
    const webhookSecret = existing?.evolution_webhook_secret
      ? decrypt(existing.evolution_webhook_secret)
      : randomBytes(32).toString('hex')
    const webhookUrl = new URL('/api/whatsapp/webhook', request.url).toString()

    let state = 'close'
    let qrcode: string | null = null
    let variant: EvolutionVariant = existing?.phone_number_id?.startsWith('evolution-go:') ? 'go' : 'v2'
    let credential = apiKey
    let instanceId = existing?.instance_id || null

    if (sameInstance) {
      state = await getEvolutionConnectionState({
        baseUrl,
        apiKey: credential,
        instanceName,
        variant,
        instanceId,
      })
    } else {
      try {
        const created = await createEvolutionInstance({ baseUrl, apiKey, instanceName })
        variant = created.variant
        credential = created.apiKey
        instanceId = created.instanceId
        qrcode = created.qrcode
      } catch (error) {
        // Evolution API v2 can return an error when the instance already exists.
        console.info('[evolution/config] create skipped; trying existing v2 instance:', error)
        variant = 'v2'
        state = await getEvolutionConnectionState({
          baseUrl,
          apiKey,
          instanceName,
          variant,
        })
      }
    }

    await setEvolutionWebhook({
      baseUrl,
      apiKey: credential,
      instanceName,
      webhookUrl,
      webhookSecret,
      variant,
      instanceId,
    })

    if (state === 'close') {
      try {
        state = await getEvolutionConnectionState({
          baseUrl,
          apiKey: credential,
          instanceName,
          variant,
          instanceId,
        })
      } catch (error) {
        console.warn('[evolution/config] state not available immediately after creation:', error)
      }
    }
    if (!isEvolutionConnected(state) && !qrcode) {
      qrcode = await connectEvolutionInstance({
        baseUrl,
        apiKey: credential,
        instanceName,
        variant,
        instanceId,
      })
    }    const connected = isEvolutionConnected(state)
    const now = new Date().toISOString()
    const row = {
      provider: 'evolution',
      phone_number_id: `evolution${variant === 'go' ? '-go' : ''}:${createHash('sha256')
        .update(`${baseUrl}:${instanceName}`)
        .digest('hex')
        .slice(0, 24)}`,
      waba_id: null,
      access_token: encrypt(credential),
      verify_token: null,
      instance_id: instanceId,
      instance_token: null,
      uazapi_base_url: null,
      evolution_base_url: baseUrl,
      evolution_instance_name: instanceName,
      evolution_webhook_secret: encrypt(webhookSecret),
      connection_state: connected ? 'connected' : 'connecting',
      status: connected ? 'connected' : 'disconnected',
      connected_at: connected ? now : null,
      registered_at: null,
      subscribed_apps_at: null,
      last_registration_error: null,
      updated_at: now,
    }

    const query = existing
      ? supabase.from('whatsapp_config').update(row).eq('account_id', accountId)
      : supabase.from('whatsapp_config').insert({
          account_id: accountId,
          user_id: userId,
          ...row,
        })
    const { error: saveError } = await query
    if (saveError) {
      console.error('[evolution/config] save failed:', saveError)
      return NextResponse.json({ error: 'Não foi possível salvar a configuração.' }, { status: 500 })
    }

    return NextResponse.json({
      success: true,
      connected,
      state,
      qrcode,
      instanceName,
      variant,
      webhookConfigured: true,
    })
  } catch (error) {
    if (error instanceof EvolutionRequestError) {
      console.error('[evolution/config] Evolution request failed:', {
        endpoint: error.endpoint,
        status: error.status,
        message: error.message,
      })
      return NextResponse.json({ error: error.message }, { status: 502 })
    }
    if (error instanceof Error && !('status' in error)) {
      console.error('[evolution/config] connection failed:', error)
      return NextResponse.json({ error: error.message }, { status: 400 })
    }
    return toErrorResponse(error)
  }
}
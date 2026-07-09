import { createHash } from 'crypto'
import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as createAdminClient } from '@supabase/supabase-js'
import { getInstanceStatus } from '@/lib/whatsapp/uazapi-client'
import { encrypt, decrypt } from '@/lib/whatsapp/encryption'

async function resolveAccountId(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
): Promise<string | null> {
  const { data, error } = await supabase
    .from('profiles')
    .select('account_id')
    .eq('user_id', userId)
    .maybeSingle()
  if (error || !data?.account_id) return null
  return data.account_id as string
}

function supabaseAdmin() {
  return createAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )
}

function normalizeBaseUrl(value: string) {
  const url = new URL(value.trim())
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('URL must start with http:// or https://')
  }
  return url.origin + url.pathname.replace(/\/$/, '')
}

function fallbackInstanceId(baseUrl: string, token: string) {
  return `uazapi:${createHash('sha256').update(`${baseUrl}:${token}`).digest('hex').slice(0, 24)}`
}

export async function POST(request: Request) {
  try {
    const supabase = await createClient()
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser()

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const accountId = await resolveAccountId(supabase, user.id)
    if (!accountId) {
      return NextResponse.json(
        { error: 'Your profile is not linked to an account.' },
        { status: 403 },
      )
    }

    const body = (await request.json()) as {
      baseUrl?: string
      instanceToken?: string
      instanceId?: string
    }

    if (!body.baseUrl?.trim() || !body.instanceToken?.trim()) {
      return NextResponse.json(
        { error: 'URL do servidor e token da instancia sao obrigatorios.' },
        { status: 400 },
      )
    }

    let baseUrl: string
    try {
      baseUrl = normalizeBaseUrl(body.baseUrl)
    } catch (err) {
      return NextResponse.json(
        { error: err instanceof Error ? err.message : 'URL invalida.' },
        { status: 400 },
      )
    }

    const instanceToken = body.instanceToken.trim()
    const status = await getInstanceStatus({ baseUrl, instanceToken })
    const instanceId = body.instanceId?.trim() || status.instanceId || fallbackInstanceId(baseUrl, instanceToken)
    const encryptedToken = encrypt(instanceToken)
    const now = new Date().toISOString()

    const { data: claimed, error: claimedError } = await supabaseAdmin()
      .from('whatsapp_config')
      .select('account_id')
      .eq('instance_id', instanceId)
      .neq('account_id', accountId)
      .maybeSingle()

    if (claimedError) {
      console.error('Error checking uazapi instance ownership:', claimedError)
      return NextResponse.json({ error: 'Failed to validate configuration' }, { status: 500 })
    }

    if (claimed) {
      return NextResponse.json(
        { error: 'Esta instancia uazapi ja esta conectada em outra conta.' },
        { status: 409 },
      )
    }

    const { data: existing } = await supabase
      .from('whatsapp_config')
      .select('id')
      .eq('account_id', accountId)
      .maybeSingle()

    const connected = status.connected || status.state === 'connected'
    const baseRow = {
      phone_number_id: instanceId,
      waba_id: null,
      access_token: encryptedToken,
      verify_token: null,
      instance_id: instanceId,
      instance_token: encryptedToken,
      uazapi_base_url: baseUrl,
      connection_state: connected ? 'connected' : status.state,
      status: connected ? 'connected' : 'disconnected',
      connected_at: connected ? now : null,
      registered_at: null,
      subscribed_apps_at: null,
      last_registration_error: null,
      updated_at: now,
    }

    const query = existing
      ? supabase.from('whatsapp_config').update(baseRow).eq('account_id', accountId)
      : supabase.from('whatsapp_config').insert({ account_id: accountId, user_id: user.id, ...baseRow })

    const { error: saveError } = await query
    if (saveError) {
      console.error('Error saving uazapi config:', saveError)
      return NextResponse.json({ error: 'Failed to save configuration' }, { status: 500 })
    }

    return NextResponse.json({
      success: true,
      connected,
      state: status.state,
      phone: status.phone,
      name: status.name,
      instanceId,
      baseUrl,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Internal server error'
    console.error('Error in /config/connect-uazapi:', error)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

export async function GET() {
  try {
    const supabase = await createClient()
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser()

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const accountId = await resolveAccountId(supabase, user.id)
    if (!accountId) {
      return NextResponse.json({ error: 'Your profile is not linked to an account.' }, { status: 403 })
    }

    const { data: config } = await supabase
      .from('whatsapp_config')
      .select('id, instance_token, uazapi_base_url, connection_state')
      .eq('account_id', accountId)
      .maybeSingle()

    if (!config?.instance_token) {
      return NextResponse.json({ connected: false, reason: 'not_configured' })
    }

    const instanceToken = decrypt(config.instance_token)
    const status = await getInstanceStatus({
      baseUrl: config.uazapi_base_url || undefined,
      instanceToken,
    })
    const connected = status.connected || status.state === 'connected'

    await supabase
      .from('whatsapp_config')
      .update({
        connection_state: connected ? 'connected' : status.state,
        status: connected ? 'connected' : 'disconnected',
        connected_at: connected ? new Date().toISOString() : null,
      })
      .eq('id', config.id)

    return NextResponse.json({ connected, state: status.state, phone: status.phone, name: status.name })
  } catch (error) {
    console.error('Error in /config/connect-uazapi GET:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

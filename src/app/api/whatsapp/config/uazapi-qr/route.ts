import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { decrypt } from '@/lib/whatsapp/encryption'
import { getInstanceQrCode } from '@/lib/whatsapp/uazapi-client'

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

function normalizeBaseUrl(value: string) {
  const url = new URL(value.trim())
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('URL must start with http:// or https://')
  }
  return url.origin + url.pathname.replace(/\/$/, '')
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

    const body = (await request.json().catch(() => ({}))) as {
      baseUrl?: string
      instanceToken?: string
    }

    const { data: config, error: configError } = await supabase
      .from('whatsapp_config')
      .select('instance_token, uazapi_base_url')
      .eq('account_id', accountId)
      .maybeSingle()

    if (configError) {
      console.error('Error loading uazapi config for QR:', configError)
      return NextResponse.json({ error: 'Failed to load configuration' }, { status: 500 })
    }

    const rawBaseUrl = body.baseUrl?.trim() || config?.uazapi_base_url || ''
    const rawInstanceToken = body.instanceToken?.trim() || (config?.instance_token ? decrypt(config.instance_token) : '')

    if (!rawBaseUrl || !rawInstanceToken) {
      return NextResponse.json(
        { error: 'Informe a URL do servidor e o token da instancia para gerar o QR Code.' },
        { status: 400 },
      )
    }

    let baseUrl: string
    try {
      baseUrl = normalizeBaseUrl(rawBaseUrl)
    } catch (err) {
      return NextResponse.json(
        { error: err instanceof Error ? err.message : 'URL invalida.' },
        { status: 400 },
      )
    }

    const result = await getInstanceQrCode({ baseUrl, instanceToken: rawInstanceToken })

    if (!result.qrcode && !result.connected) {
      return NextResponse.json(
        { error: 'A UAZAPI respondeu, mas nao enviou um QR Code para esta instancia.' },
        { status: 502 },
      )
    }

    return NextResponse.json({ success: true, ...result })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Internal server error'
    console.error('Error in /config/uazapi-qr:', error)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
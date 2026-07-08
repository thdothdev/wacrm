import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as createAdminClient } from '@supabase/supabase-js'
import { connectInstance, setWebhook } from '@/lib/whatsapp/uazapi-client'
import { encrypt } from '@/lib/whatsapp/encryption'

/**
 * Resolve the caller's account_id from their profile.
 */
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
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )
}

/**
 * POST /api/whatsapp/config/connect-uazapi
 *
 * Initiates a WhatsApp connection via uazapi.
 * Returns a QR code or pairing code that the user scans/enters on their WhatsApp app.
 *
 * Request body:
 *   { phone?: '5511999999999' }  // Optional: if provided, returns pairing code; else returns QR code
 *
 * Response:
 *   { qrcode: 'data:image/png;base64,...', instanceToken: '...' }  // QR mode
 *   { pairingCode: '111-222', instanceToken: '...' }  // Pairing mode
 *   { error: '...' }  // Error
 */
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
        { status: 403 }
      )
    }

    const body = await request.json() as { phone?: string }
    const { phone } = body

    // Check if this account already has a uazapi instance connected
    const { data: existing } = await supabase
      .from('whatsapp_config')
      .select('id, instance_id, instance_token, connection_state')
      .eq('account_id', accountId)
      .maybeSingle()

    if (existing?.instance_token && existing.connection_state === 'connected') {
      return NextResponse.json(
        { error: 'This account already has a WhatsApp instance connected. Disconnect first.' },
        { status: 400 }
      )
    }

    // Call uazapi to initiate connection
    try {
      const result = await connectInstance({ phone })

      if (!result.success || !result.instanceToken) {
        return NextResponse.json(
          { error: result.message || 'Failed to initiate connection' },
          { status: 400 }
        )
      }

      // Encrypt the instance token before storing
      let encryptedInstanceToken: string
      try {
        encryptedInstanceToken = encrypt(result.instanceToken)
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown encryption error'
        console.error('Token encryption failed:', message)
        return NextResponse.json(
          {
            error:
              'Failed to encrypt token. Check that ENCRYPTION_KEY is a valid 64-character hex string.',
          },
          { status: 500 }
        )
      }

      // Store the pending connection state in the database
      const baseRow = {
        instance_id: result.instanceId || null,
        instance_token: encryptedInstanceToken,
        connection_state: 'connecting',
        connected_at: null,
        updated_at: new Date().toISOString(),
      }

      if (existing) {
        // Update existing row
        const { error: updateError } = await supabase
          .from('whatsapp_config')
          .update(baseRow)
          .eq('account_id', accountId)

        if (updateError) {
          console.error('Error updating whatsapp_config:', updateError)
          return NextResponse.json(
            { error: 'Failed to update configuration' },
            { status: 500 }
          )
        }
      } else {
        // Insert new row
        const { error: insertError } = await supabase
          .from('whatsapp_config')
          .insert({
            account_id: accountId,
            user_id: user.id,
            ...baseRow,
          })

        if (insertError) {
          console.error('Error inserting whatsapp_config:', insertError)
          return NextResponse.json(
            { error: 'Failed to save configuration' },
            { status: 500 }
          )
        }
      }

      // Return QR code or pairing code
      return NextResponse.json({
        success: true,
        qrcode: result.qrcode,
        pairingCode: result.pairingCode,
        instanceToken: result.instanceToken, // Return plain token so frontend can store it if needed
        message: result.qrcode
          ? 'Scan this QR code with your WhatsApp app'
          : 'Enter this pairing code in WhatsApp → Link Device',
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown uazapi error'
      console.error('uazapi connectInstance failed:', message)
      return NextResponse.json(
        { error: `uazapi error: ${message}` },
        { status: 400 }
      )
    }
  } catch (error) {
    console.error('Error in /config/connect-uazapi:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}

/**
 * GET /api/whatsapp/config/connect-uazapi
 *
 * Check the current connection status of a uazapi instance.
 * Used by the frontend to poll after showing QR code.
 *
 * Response:
 *   { connected: true, phone: '5511999999999' }
 *   { connected: false, state: 'connecting' }
 */
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
      return NextResponse.json(
        { error: 'Your profile is not linked to an account.' },
        { status: 403 }
      )
    }

    const { data: config } = await supabase
      .from('whatsapp_config')
      .select('instance_token, connection_state')
      .eq('account_id', accountId)
      .maybeSingle()

    if (!config?.instance_token) {
      return NextResponse.json({ connected: false, reason: 'not_configured' })
    }

    // Check connection state stored in DB (we'll update this when webhooks arrive)
    return NextResponse.json({
      connected: config.connection_state === 'connected',
      state: config.connection_state,
    })
  } catch (error) {
    console.error('Error in /config/connect-uazapi GET:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createEvolutionInstance,
  normalizeEvolutionBaseUrl,
  setEvolutionWebhook,
} from './evolution-client'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Evolution client', () => {
  it('rejects internal server URLs', () => {
    expect(() => normalizeEvolutionBaseUrl('http://localhost:8080')).toThrow()
    expect(() => normalizeEvolutionBaseUrl('http://192.168.1.10')).toThrow()
  })

  it('creates an instance and returns a browser-ready QR code', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ qrcode: { base64: 'abc123' } }), { status: 200 }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const qr = await createEvolutionInstance({
      baseUrl: 'https://evolution.example.com',
      apiKey: 'global-key',
      instanceName: 'autoia',
    })

    expect(qr).toMatchObject({ variant: 'v2', qrcode: 'data:image/png;base64,abc123' })
    expect(fetchMock).toHaveBeenCalledWith(
      'https://evolution.example.com/instance/create',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ apikey: 'global-key' }),
      }),
    )
    const init = fetchMock.mock.calls[0][1] as RequestInit
    expect(JSON.parse(String(init.body))).toMatchObject({
      instanceName: 'autoia',
      qrcode: true,
      integration: 'WHATSAPP-BAILEYS',
    })
  })

  it('falls back to Evolution Go when the v2 payload is rejected', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ error: { message: 'Instance information is required' } }),
        { status: 400 },
      ))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: { id: 'go-id', name: 'autoia', token: 'instance-token' },
      }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const created = await createEvolutionInstance({
      baseUrl: 'https://evolution.example.com',
      apiKey: 'global-key',
      instanceName: 'autoia',
    })

    expect(created).toMatchObject({
      variant: 'go',
      apiKey: 'instance-token',
      instanceId: 'go-id',
    })
    const goRequest = fetchMock.mock.calls[1][1] as RequestInit
    expect(JSON.parse(String(goRequest.body))).toEqual({ name: 'autoia' })
  })
  it('configures the account webhook with its secret header', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await setEvolutionWebhook({
      baseUrl: 'https://evolution.example.com',
      apiKey: 'global-key',
      instanceName: 'autoia',
      webhookUrl: 'https://crm.example.com/api/whatsapp/webhook',
      webhookSecret: 'account-secret',
    })

    const init = fetchMock.mock.calls[0][1] as RequestInit
    expect(JSON.parse(String(init.body))).toMatchObject({
      enabled: true,
      headers: { 'x-autoia-webhook-token': 'account-secret' },
      events: ['MESSAGES_UPSERT', 'MESSAGES_UPDATE', 'CONNECTION_UPDATE'],
    })
  })
})
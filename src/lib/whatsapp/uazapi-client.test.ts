import { describe, expect, it } from 'vitest'
import { normalizeQrCodeForDisplay } from './uazapi-client'

describe('normalizeQrCodeForDisplay', () => {
  it('keeps image data urls unchanged', () => {
    const value = 'data:image/png;base64,abc123'
    expect(normalizeQrCodeForDisplay(value)).toBe(value)
  })

  it('wraps bare base64 QR images in a png data url', () => {
    const value = 'a'.repeat(120)
    expect(normalizeQrCodeForDisplay(value)).toBe(`data:image/png;base64,${value}`)
  })
})
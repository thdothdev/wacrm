import type { SupabaseClient } from '@supabase/supabase-js'

const NAME_WORD = String.raw`\p{L}[\p{L}'-]*`
const NAME_STARTERS = [
  new RegExp(
    String.raw`^(?:ol[a\u00e1]|oi|bom dia|boa tarde|boa noite|hello|hi|hey)[,!\.\s]+(${NAME_WORD}(?:\s+${NAME_WORD}){0,2})(?=[,!.?]|$)`,
    'iu',
  ),
  new RegExp(
    String.raw`^(?:perfeito|claro|certo|combinado|obrigad[oa])[,!\.\s]+(${NAME_WORD}(?:\s+${NAME_WORD}){0,2})(?=[,!.?]|$)`,
    'iu',
  ),
]

const NOT_NAMES = new Set([
  'aqui',
  'atendimento',
  'boa',
  'bom',
  'cliente',
  'consigo',
  'nao',
  'n\u00e3o',
  'obrigada',
  'obrigado',
  'oi',
  'ol\u00e1',
  'ola',
  'posso',
  'sim',
  'tudo',
  'vamos',
  'voce',
  'voc\u00ea',
  'whatsapp',
])

interface LearnedNameArgs {
  accountId: string
  contactId: string
  replyText: string
}

interface ContactRow {
  id: string
  name: string | null
  phone: string | null
}

interface DealRow {
  id: string
  title: string | null
}

export function extractCustomerNameFromAiReply(text: string): string | null {
  const firstLine = text.trim().split(/\r?\n/, 1)[0]?.trim() ?? ''
  if (!firstLine) return null

  for (const pattern of NAME_STARTERS) {
    const match = firstLine.match(pattern)
    const cleaned = cleanName(match?.[1])
    if (cleaned) return cleaned
  }

  return null
}

export async function maybeUpdateContactNameFromAiReply(
  db: SupabaseClient,
  args: LearnedNameArgs,
): Promise<void> {
  const learnedName = extractCustomerNameFromAiReply(args.replyText)
  if (!learnedName) return

  try {
    const { data: contact, error } = await db
      .from('contacts')
      .select('id, name, phone')
      .eq('account_id', args.accountId)
      .eq('id', args.contactId)
      .maybeSingle<ContactRow>()

    if (error || !contact) return
    if (hasRealName(contact.name, contact.phone)) return

    const { error: updateError } = await db
      .from('contacts')
      .update({ name: learnedName })
      .eq('account_id', args.accountId)
      .eq('id', args.contactId)

    if (updateError) {
      console.warn('[ai auto-reply] could not update learned contact name:', updateError)
      return
    }

    const { data: deals } = await db
      .from('deals')
      .select('id, title')
      .eq('account_id', args.accountId)
      .eq('contact_id', args.contactId)
      .eq('status', 'open')
      .returns<DealRow[]>()

    await Promise.all(
      (deals ?? [])
        .filter((deal) => shouldRefreshDealTitle(deal.title, contact.phone))
        .map((deal) =>
          db
            .from('deals')
            .update({ title: `${learnedName} lead` })
            .eq('account_id', args.accountId)
            .eq('id', deal.id),
        ),
    )
  } catch (err) {
    console.warn('[ai auto-reply] learned name sync skipped:', err)
  }
}

function cleanName(raw: string | undefined): string | null {
  const name = raw
    ?.replace(/"/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^[,!.?\s]+|[,!.?\s]+$/g, '')
    .trim()

  if (!name || name.length < 2 || name.length > 60) return null
  if (/\d|@|https?:\/\//i.test(name)) return null

  const words = name.split(' ')
  const first = normalizeWord(words[0])
  if (!first || NOT_NAMES.has(first)) return null
  if (words.some((word) => NOT_NAMES.has(normalizeWord(word)))) return null

  return words.map(formatNameWord).join(' ')
}

function hasRealName(name: string | null | undefined, phone: string | null | undefined): boolean {
  const trimmed = name?.trim()
  if (!trimmed) return false

  const nameDigits = trimmed.replace(/\D/g, '')
  const phoneDigits = phone?.replace(/\D/g, '') ?? ''
  if (nameDigits.length >= 7) return false
  if (phoneDigits && nameDigits === phoneDigits) return false
  if (trimmed.includes('@s.whatsapp.net')) return false

  return true
}

function shouldRefreshDealTitle(title: string | null | undefined, phone: string | null | undefined): boolean {
  const trimmed = title?.trim()
  if (!trimmed) return true

  const phoneDigits = phone?.replace(/\D/g, '') ?? ''
  const titleDigits = trimmed.replace(/\D/g, '')

  if (/^\+?\d[\d\s().-]{6,}\s+lead$/i.test(trimmed)) return true
  return Boolean(phoneDigits && titleDigits === phoneDigits && /lead$/i.test(trimmed))
}

function normalizeWord(word: string | undefined): string {
  return (word ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
}

function formatNameWord(word: string, index: number): string {
  const lower = word.toLowerCase()
  if (index > 0 && ['da', 'de', 'do', 'das', 'dos'].includes(lower)) {
    return lower
  }
  return lower.charAt(0).toUpperCase() + lower.slice(1)
}
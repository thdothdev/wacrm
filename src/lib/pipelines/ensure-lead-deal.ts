import type { SupabaseClient } from '@supabase/supabase-js'

const DEFAULT_PIPELINE_NAME = 'Sales Pipeline'
const DEFAULT_STAGES = [
  { name: 'New Lead', color: '#3b82f6', position: 0 },
  { name: 'Qualified', color: '#eab308', position: 1 },
  { name: 'Proposal Sent', color: '#f97316', position: 2 },
  { name: 'Negotiation', color: '#8b5cf6', position: 3 },
  { name: 'Won', color: '#22c55e', position: 4 },
]

export async function ensureLeadDealForConversation(
  db: SupabaseClient,
  input: {
    accountId: string
    userId: string
    contactId: string
    conversationId: string
    contactName?: string | null
    contactPhone?: string | null
  },
): Promise<void> {
  const { accountId, userId, contactId, conversationId } = input

  const { data: existingDeal, error: existingErr } = await db
    .from('deals')
    .select('id')
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    .eq('status', 'open')
    .limit(1)
    .maybeSingle()

  if (existingErr) throw existingErr
  if (existingDeal) return

  const pipeline = await ensurePipeline(db, accountId, userId)
  if (!pipeline) return

  const stage = await ensureLeadStage(db, pipeline.id)
  if (!stage) return

  const { data: account } = await db
    .from('accounts')
    .select('default_currency')
    .eq('id', accountId)
    .maybeSingle()

  const title = buildLeadTitle(input.contactName, input.contactPhone)
  const { error } = await db.from('deals').insert({
    account_id: accountId,
    user_id: userId,
    pipeline_id: pipeline.id,
    stage_id: stage.id,
    contact_id: contactId,
    conversation_id: conversationId,
    title,
    value: 0,
    currency: account?.default_currency ?? 'USD',
    status: 'open',
  })

  if (error) throw error
}


export async function moveOpenDealToQualified(
  db: SupabaseClient,
  input: {
    accountId: string
    userId: string
    contactId: string
    conversationId: string
    contactName?: string | null
    contactPhone?: string | null
  },
): Promise<void> {
  await ensureLeadDealForConversation(db, input)

  const { data: deal, error: dealError } = await db
    .from('deals')
    .select('id, pipeline_id')
    .eq('account_id', input.accountId)
    .eq('contact_id', input.contactId)
    .eq('status', 'open')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (dealError) throw dealError
  if (!deal) return

  const stage = await ensureStageByName(db, deal.pipeline_id, 'Qualified')
  if (!stage) return

  const { error } = await db
    .from('deals')
    .update({
      stage_id: stage.id,
      conversation_id: input.conversationId,
    })
    .eq('account_id', input.accountId)
    .eq('id', deal.id)

  if (error) throw error
}
async function ensurePipeline(db: SupabaseClient, accountId: string, userId: string) {
  const { data: existing, error } = await db
    .from('pipelines')
    .select('id')
    .eq('account_id', accountId)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle()

  if (error) throw error
  if (existing) return existing

  const { data: created, error: createError } = await db
    .from('pipelines')
    .insert({ account_id: accountId, user_id: userId, name: DEFAULT_PIPELINE_NAME })
    .select('id')
    .single()

  if (createError) throw createError

  const { error: stagesError } = await db.from('pipeline_stages').insert(
    DEFAULT_STAGES.map((stage) => ({ ...stage, pipeline_id: created.id })),
  )
  if (stagesError) throw stagesError

  return created
}

async function ensureLeadStage(db: SupabaseClient, pipelineId: string) {
  const { data: stages, error } = await db
    .from('pipeline_stages')
    .select('id, name, position')
    .eq('pipeline_id', pipelineId)
    .order('position', { ascending: true })

  if (error) throw error

  const lead = stages?.find((stage) => stage.name.toLowerCase() === 'new lead')
  if (lead) return lead
  if (stages?.[0]) return stages[0]

  const { error: insertError } = await db.from('pipeline_stages').insert(
    DEFAULT_STAGES.map((stage) => ({ ...stage, pipeline_id: pipelineId })),
  )
  if (insertError) throw insertError

  const { data: createdLead, error: fetchError } = await db
    .from('pipeline_stages')
    .select('id, name, position')
    .eq('pipeline_id', pipelineId)
    .eq('name', 'New Lead')
    .maybeSingle()

  if (fetchError) throw fetchError
  return createdLead
}

function buildLeadTitle(name?: string | null, phone?: string | null): string {
  const label = name?.trim() || phone?.trim() || 'New contact'
  return `${label} lead`
}
async function ensureStageByName(db: SupabaseClient, pipelineId: string, name: string) {
  const { data: stage, error } = await db
    .from('pipeline_stages')
    .select('id, name, position')
    .eq('pipeline_id', pipelineId)
    .ilike('name', name)
    .limit(1)
    .maybeSingle()

  if (error) throw error
  if (stage) return stage

  const fallback = DEFAULT_STAGES.find((s) => s.name.toLowerCase() === name.toLowerCase())
  const { data: created, error: createError } = await db
    .from('pipeline_stages')
    .insert({
      pipeline_id: pipelineId,
      name,
      color: fallback?.color ?? '#eab308',
      position: fallback?.position ?? 1,
    })
    .select('id, name, position')
    .single()

  if (createError) throw createError
  return created
}

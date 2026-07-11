'use client';

import { useEffect, useState } from 'react';
import { Bot, Power } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { canEditSettings } from '@/lib/auth/roles';
import { useAuth } from '@/hooks/use-auth';

export function AiAutoReplyToggle() {
  const t = useTranslations('AiAgents.page');
  const { accountRole } = useAuth();
  const canEdit = accountRole ? canEditSettings(accountRole) : false;
  const [configured, setConfigured] = useState(false);
  const [active, setActive] = useState(false);
  const [autoReply, setAutoReply] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let alive = true;
    fetch('/api/ai/config')
      .then((res) => res.json())
      .then((data) => {
        if (!alive) return;
        setConfigured(Boolean(data.configured));
        setActive(Boolean(data.is_active));
        setAutoReply(Boolean(data.auto_reply_enabled));
      })
      .catch(() => toast.error(t('statusLoadFailed')))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [t]);

  const toggle = async () => {
    const next = !autoReply;
    setSaving(true);
    try {
      const res = await fetch('/api/ai/config', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ auto_reply_enabled: next }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? t('statusSaveFailed'));
      setAutoReply(next);
      toast.success(next ? t('agentEnabledToast') : t('agentDisabledToast'));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('statusSaveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const disabled = loading || saving || !configured || !active || !canEdit;
  const status = !configured
    ? t('agentNotConfigured')
    : !active
      ? t('agentInactive')
      : autoReply
        ? t('agentEnabled')
        : t('agentDisabled');

  return (
    <div className="mt-4 flex flex-col gap-3 rounded-lg border border-border bg-card p-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex items-start gap-3">
        <div className="rounded-lg bg-primary/10 p-2 text-primary">
          <Bot className="h-4 w-4" />
        </div>
        <div>
          <p className="text-sm font-medium text-foreground">{t('inboxAgentControl')}</p>
          <p className="text-xs text-muted-foreground">{status}</p>
        </div>
      </div>
      <Button
        type="button"
        variant={autoReply ? 'destructive' : 'default'}
        onClick={toggle}
        disabled={disabled}
      >
        <Power className="h-4 w-4" />
        {saving ? t('saving') : autoReply ? t('disableAgent') : t('enableAgent')}
      </Button>
    </div>
  );
}

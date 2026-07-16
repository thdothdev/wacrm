'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { toast } from 'sonner';
import {
  Eye,
  EyeOff,
  Copy,
  CheckCircle2,
  XCircle,
  Loader2,
  ExternalLink,
  Zap,
  AlertTriangle,
  RotateCcw,
  QrCode as QrCodeIcon,
} from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { SettingsPanelHead } from './settings-panel-head';
import {
  Accordion,
  AccordionItem,
  AccordionTrigger,
  AccordionContent,
} from '@/components/ui/accordion';
import type { WhatsAppConfig as WhatsAppConfigType } from '@/types';

const MASKED_TOKEN = '••••••••••••••••';

type ConnectionStatus = 'connected' | 'disconnected' | 'unknown';
type ResetReason = 'token_corrupted' | 'meta_api_error' | null;

export function WhatsAppConfig() {
  const t = useTranslations('Settings.whatsapp');
  const supabase = createClient();
  // After multi-user, whatsapp_config is one-row-per-account, not
  // one-row-per-user. We pull `accountId` straight off the auth
  // context and key every read off it — so a teammate who just
  // joined an account sees the inviter's saved config without
  // having to re-enter anything.
  const { user, accountId, loading: authLoading, profileLoading } = useAuth();

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [showToken, setShowToken] = useState(false);
  const [config, setConfig] = useState<WhatsAppConfigType | null>(null);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('unknown');
  const [resetReason, setResetReason] = useState<ResetReason>(null);
  const [statusMessage, setStatusMessage] = useState<string>('');
  // Guards against re-hydrating the form when the load effect below
  // re-runs for reasons unrelated to actually switching accounts —
  // e.g. Supabase's onAuthStateChange fires a token refresh (new
  // `user` object, profileLoading flips true/false) when the browser
  // tab regains focus. Without this, that churn calls fetchConfig()
  // again and overwrites whatever the user typed but hadn't saved yet.
  const loadedAccountIdRef = useRef<string | null>(null);

  const [phoneNumberId, setPhoneNumberId] = useState('');
  const [wabaId, setWabaId] = useState('');
  const [accessToken, setAccessToken] = useState('');
  const [uazapiBaseUrl, setUazapiBaseUrl] = useState('');
  const [uazapiToken, setUazapiToken] = useState('');
  const [uazapiTokenEdited, setUazapiTokenEdited] = useState(false);
  const [qrLoading, setQrLoading] = useState(false);
  const [uazapiQrCode, setUazapiQrCode] = useState<string | null>(null);
  const [evolutionBaseUrl, setEvolutionBaseUrl] = useState('');
  const [evolutionInstanceName, setEvolutionInstanceName] = useState('');
  const [evolutionApiKey, setEvolutionApiKey] = useState('');
  const [evolutionApiKeyEdited, setEvolutionApiKeyEdited] = useState(false);
  const [evolutionQrCode, setEvolutionQrCode] = useState<string | null>(null);
  const [verifyToken, setVerifyToken] = useState('');
  const [pin, setPin] = useState('');
  const [tokenEdited, setTokenEdited] = useState(false);
  const [provider, setProvider] = useState<'meta' | 'uazapi' | 'evolution'>('uazapi');

  // True once /register has succeeded on Meta's side (timestamp set
  // in the row). When false, the saved config is metadata-only and
  // Meta will silently drop every inbound event — that's the
  // multi-number bug that prompted this work.
  const isRegistered = Boolean(config?.registered_at);
  const lastRegistrationError = config?.last_registration_error ?? null;

  const [verifyingRegistration, setVerifyingRegistration] = useState(false);
  type RegistrationProbe = {
    live: boolean;
    checks: Record<string, boolean | null>;
    errors?: string[];
    last_registration_error?: string | null;
    registered_at?: string | null;
    subscribed_apps_at?: string | null;
  };
  const [registrationProbe, setRegistrationProbe] =
    useState<RegistrationProbe | null>(null);

  const webhookUrl =
    typeof window !== 'undefined'
      ? `${window.location.origin}/api/whatsapp/webhook`
      : '';

  const uazapiWebhookUrl = webhookUrl
    ? `${webhookUrl}?uazapi_token=SEU_TOKEN_DA_VERCEL`
    : '';

  const fetchConfig = useCallback(async (acctId: string) => {
    setLoading(true);
    try {
      // Load form values from Supabase (shows what's in DB).
      // Switched from `user_id` (which would only match the row's
      // original author) to `account_id` so every member of the
      // account sees the same saved configuration. UNIQUE(account_id)
      // on the table guarantees the .maybeSingle() return type
      // remains accurate.
      const { data, error } = await supabase
        .from('whatsapp_config')
        .select('id, user_id, provider, phone_number_id, waba_id, access_token, verify_token, instance_id, instance_token, uazapi_base_url, evolution_base_url, evolution_instance_name, connection_state, status, connected_at, registered_at, subscribed_apps_at, last_registration_error')
        .eq('account_id', acctId)
        .maybeSingle();

      if (error) {
        console.error('Failed to load config row:', error);
      }

      if (data) {
        setConfig(data);
        setProvider((data.provider || (data.instance_token ? 'uazapi' : 'meta')) as 'meta' | 'uazapi' | 'evolution');
        setPhoneNumberId(data.phone_number_id || '');
        setWabaId(data.waba_id || '');
        setAccessToken(data.access_token && !data.instance_token ? MASKED_TOKEN : '');
        setUazapiBaseUrl(data.uazapi_base_url || '');
        setUazapiToken(data.instance_token ? MASKED_TOKEN : '');
        setUazapiTokenEdited(false);
        setEvolutionBaseUrl(data.evolution_base_url || '');
        setEvolutionInstanceName(data.evolution_instance_name || '');
        setEvolutionApiKey(data.provider === 'evolution' && data.access_token ? MASKED_TOKEN : '');
        setEvolutionApiKeyEdited(false);
        setVerifyToken('');
        setPin('');
        setTokenEdited(false);
      } else {
        setConfig(null);
        setPhoneNumberId('');
        setWabaId('');
        setAccessToken('');
        setUazapiBaseUrl('');
        setUazapiToken('');
        setUazapiTokenEdited(false);
        setEvolutionBaseUrl('');
        setEvolutionInstanceName('');
        setEvolutionApiKey('');
        setEvolutionApiKeyEdited(false);
        setVerifyToken('');
        setPin('');
        setTokenEdited(false);
      }
      // Clear any stale probe result when reloading the row.
      setRegistrationProbe(null);
      setUazapiQrCode(null);
      setEvolutionQrCode(null);

      // Then verify health via the API (decrypts token + pings Meta)
      if (data) {
        try {
          const res = await fetch('/api/whatsapp/config', { method: 'GET' });
          const payload = await res.json();

          if (payload.connected) {
            setConnectionStatus('connected');
            setResetReason(null);
            setStatusMessage('');
          } else {
            setConnectionStatus('disconnected');
            setResetReason(payload.needs_reset ? 'token_corrupted' : payload.reason === 'meta_api_error' ? 'meta_api_error' : null);
            setStatusMessage(payload.message || '');
          }
        } catch (err) {
          console.error('Health check failed:', err);
          setConnectionStatus('disconnected');
        }
      } else {
        setConnectionStatus('disconnected');
        setResetReason(null);
        setStatusMessage('');
      }
    } catch (err) {
      console.error('fetchConfig error:', err);
      toast.error('Failed to load WhatsApp configuration');
    } finally {
      setLoading(false);
    }
  }, [supabase]);

  useEffect(() => {
    // Need both the auth session (`!authLoading`) AND the profile
    // (`!profileLoading`, which carries `accountId`). Without the
    // second guard, the effect would fire with `accountId === null`
    // for the first render window and bail without ever retrying
    // once the profile arrives.
    if (authLoading || profileLoading) return;
    if (!user || !accountId) {
      loadedAccountIdRef.current = null;
      setLoading(false);
      return;
    }
    if (loadedAccountIdRef.current === accountId) return;
    loadedAccountIdRef.current = accountId;
    fetchConfig(accountId);
  }, [authLoading, profileLoading, user?.id, accountId, fetchConfig]);

  async function handleConnectEvolution() {
    if (!evolutionBaseUrl.trim()) {
      toast.error('Informe a URL do servidor Evolution.');
      return;
    }
    if (!evolutionInstanceName.trim()) {
      toast.error('Informe um nome para a nova instância.');
      return;
    }
    const hasSavedKey = config?.provider === 'evolution' && Boolean(config.access_token);
    if (!hasSavedKey && (!evolutionApiKey.trim() || !evolutionApiKeyEdited)) {
      toast.error('Informe a API Key global da Evolution.');
      return;
    }

    try {
      setQrLoading(true);
      setEvolutionQrCode(null);
      const response = await fetch('/api/whatsapp/config/connect-evolution', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          baseUrl: evolutionBaseUrl.trim(),
          instanceName: evolutionInstanceName.trim(),
          apiKey: evolutionApiKeyEdited ? evolutionApiKey.trim() : undefined,
        }),
      });
      const data = await response.json();
      if (!response.ok) {
        toast.error(data.error || 'Não foi possível criar a instância Evolution.');
        return;
      }
      setEvolutionApiKey(MASKED_TOKEN);
      setEvolutionApiKeyEdited(false);
      setConnectionStatus(data.connected ? 'connected' : 'disconnected');
      toast.success(data.connected ? 'Evolution conectada.' : 'Instância criada. Escaneie o QR Code.');
      if (accountId) await fetchConfig(accountId);
      setEvolutionQrCode(data.connected ? null : data.qrcode || null);
    } catch (error) {
      console.error('Evolution connection failed:', error);
      toast.error('Falha ao conectar com a Evolution.');
    } finally {
      setQrLoading(false);
    }
  }
  useEffect(() => {
    if (provider !== 'evolution' || !evolutionQrCode || !accountId) return;

    const interval = window.setInterval(async () => {
      try {
        const response = await fetch('/api/whatsapp/config');
        const data = await response.json();
        if (data.connected && data.api_type === 'evolution') {
          window.clearInterval(interval);
          setEvolutionQrCode(null);
          setConnectionStatus('connected');
          toast.success('WhatsApp conectado pela Evolution.');
          await fetchConfig(accountId);
        }
      } catch {
        // Keep the QR visible and try again on the next interval.
      }
    }, 5000);

    return () => window.clearInterval(interval);
  }, [accountId, evolutionQrCode, fetchConfig, provider]);
  async function handleSaveUazapi() {
    if (!uazapiBaseUrl.trim()) {
      toast.error('Informe a URL do servidor uazapi');
      return;
    }
    if (!config?.instance_token && (!uazapiToken.trim() || !uazapiTokenEdited)) {
      toast.error('Informe o token da instancia uazapi');
      return;
    }
    if (config?.instance_token && !uazapiTokenEdited) {
      toast.error('Reinforme o token da instancia para salvar alteracoes');
      return;
    }

    try {
      setSaving(true);
      const res = await fetch('/api/whatsapp/config/connect-uazapi', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          baseUrl: uazapiBaseUrl.trim(),
          instanceToken: uazapiToken.trim(),
        }),
      });
      const data = await res.json();

      if (!res.ok) {
        toast.error(data.error || 'Falha ao conectar com uazapi');
        return;
      }

      toast.success(data.connected ? 'uazapi conectado' : 'Credenciais salvas; escaneie o QR code na uazapi se ainda nao estiver conectado');
      if (accountId) await fetchConfig(accountId);
    } catch (err) {
      console.error('uazapi save error:', err);
      toast.error('Falha ao salvar uazapi');
    } finally {
      setSaving(false);
    }
  }

  async function handleGenerateUazapiQr() {
    if (!uazapiBaseUrl.trim()) {
      toast.error('Informe a URL do servidor uazapi');
      return;
    }

    const hasTypedToken = uazapiTokenEdited && uazapiToken.trim() && uazapiToken !== MASKED_TOKEN;
    if (!config?.instance_token && !hasTypedToken) {
      toast.error('Informe o token da instancia uazapi');
      return;
    }

    try {
      setQrLoading(true);
      setUazapiQrCode(null);

      if (hasTypedToken) {
        const saveRes = await fetch('/api/whatsapp/config/connect-uazapi', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            baseUrl: uazapiBaseUrl.trim(),
            instanceToken: uazapiToken.trim(),
          }),
        });
        const saveData = await saveRes.json();
        if (!saveRes.ok) {
          toast.error(saveData.error || 'Falha ao salvar credenciais da uazapi');
          return;
        }
        setUazapiToken(MASKED_TOKEN);
        setUazapiTokenEdited(false);
        if (saveData.connected) {
          setConnectionStatus('connected');
          toast.success('uazapi conectado');
          if (accountId) await fetchConfig(accountId);
          return;
        }
      }

      const res = await fetch('/api/whatsapp/config/uazapi-qr', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ baseUrl: uazapiBaseUrl.trim() }),
      });
      const data = await res.json();

      if (!res.ok) {
        toast.error(data.error || 'Falha ao gerar QR Code da uazapi');
        return;
      }

      if (data.connected && !data.qrcode) {
        setConnectionStatus('connected');
        toast.success('Instancia uazapi ja esta conectada');
        if (accountId) await fetchConfig(accountId);
        return;
      }

      if (!data.qrcode) {
        toast.error('A uazapi nao retornou um QR Code para esta instancia');
        return;
      }

      setUazapiQrCode(data.qrcode);
      toast.success('QR Code gerado. Escaneie pelo WhatsApp.');
    } catch (err) {
      console.error('uazapi QR error:', err);
      toast.error('Falha ao gerar QR Code da uazapi');
    } finally {
      setQrLoading(false);
    }
  }

  async function handleSave() {
    if (!phoneNumberId.trim()) {
      toast.error('Phone Number ID is required');
      return;
    }
    if (!config && (!accessToken.trim() || !tokenEdited)) {
      toast.error('Access Token is required for initial setup');
      return;
    }

    try {
      setSaving(true);

      // Always POST through the API — it verifies with Meta and encrypts
      // the access_token server-side with ENCRYPTION_KEY. Skipping this
      // and writing direct to Supabase stores the token in plaintext,
      // which then fails decryption on every subsequent health check.
      const payload: Record<string, unknown> = {
        phone_number_id: phoneNumberId.trim(),
        waba_id: wabaId.trim() || null,
        verify_token: verifyToken.trim() || null,
        // Optional — only sent when the user filled it in. The server
        // requires it on first save or when changing numbers; for a
        // simple token rotation, leaving it blank skips re-register.
        pin: pin.trim() || null,
      };

      if (tokenEdited && accessToken !== MASKED_TOKEN && accessToken.trim()) {
        payload.access_token = accessToken.trim();
      } else if (config) {
        // Existing config — reuse stored encrypted token by decrypting on the
        // server. But our POST handler requires an access_token to verify
        // with Meta. If the user didn't change the token, we need to signal
        // that. Simplest: require token re-entry if they're updating.
        toast.error('Please re-enter the Access Token to save changes');
        setSaving(false);
        return;
      }

      const res = await fetch('/api/whatsapp/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      const data = await res.json();

      if (!res.ok) {
        toast.error(data.error || 'Failed to save configuration');
        setSaving(false);
        return;
      }

      // The route now returns a structured outcome:
      //   * registered=true   → number is live, events will flow
      //   * registered=false  → credentials saved but /register
      //                         failed; UI shows the specific error
      //                         and a retry path. registration_error
      //                         is human-readable from Meta.
      if (data.registered === false && data.registration_error) {
        toast.error(
          `Saved, but Meta couldn't register the number: ${data.registration_error}`,
          { duration: 12000 },
        );
      } else if (data.registration_skipped) {
        // Credentials saved + verified, but /register was skipped
        // because no PIN was supplied (e.g. a Meta test number).
        // Don't claim the number is "Live" — point at the
        // Registration status banner instead.
        toast.success(
          'Credentials saved and verified. Inbound registration was skipped (no PIN) — see Registration status below.',
          { duration: 10000 },
        );
        setPin('');
      } else {
        toast.success(
          data.phone_info?.verified_name
            ? `Live — ${data.phone_info.verified_name} can now receive events.`
            : 'WhatsApp connected. Events will start flowing within a minute.',
        );
        // Clear the PIN so subsequent saves don't accidentally
        // re-register (which would void the active subscription if
        // the PIN became stale).
        setPin('');
      }

      if (accountId) await fetchConfig(accountId);
    } catch (err) {
      console.error('Save error:', err);
      toast.error('Failed to save configuration');
    } finally {
      setSaving(false);
    }
  }

  async function handleTestConnection() {
    try {
      setTesting(true);
      const res = await fetch('/api/whatsapp/config', { method: 'GET' });
      const payload = await res.json();

      if (payload.connected) {
        setConnectionStatus('connected');
        setResetReason(null);
        setStatusMessage('');
        toast.success(
          payload.phone_info?.verified_name
            ? `Connected to ${payload.phone_info.verified_name}`
            : 'API connection successful'
        );
      } else {
        setConnectionStatus('disconnected');
        setResetReason(payload.needs_reset ? 'token_corrupted' : payload.reason === 'meta_api_error' ? 'meta_api_error' : null);
        setStatusMessage(payload.message || '');
        toast.error(payload.message || 'API connection failed');
      }
    } catch (err) {
      console.error('Test connection error:', err);
      setConnectionStatus('disconnected');
      toast.error('Connection test failed. Check network and try again.');
    } finally {
      setTesting(false);
    }
  }

  async function handleVerifyRegistration() {
    setVerifyingRegistration(true);
    setRegistrationProbe(null);
    try {
      const res = await fetch('/api/whatsapp/config/verify-registration', {
        method: 'GET',
      });
      const data = (await res.json()) as RegistrationProbe;
      setRegistrationProbe(data);
      if (data.live) {
        toast.success('Number is fully wired — Meta is delivering events.');
      } else {
        toast.error(
          'Number is not fully registered. See the checks below for which step failed.',
          { duration: 8000 },
        );
      }
      if (accountId) await fetchConfig(accountId);
    } catch (err) {
      console.error('verify-registration failed:', err);
      toast.error('Could not reach the verification endpoint.');
    } finally {
      setVerifyingRegistration(false);
    }
  }

  async function handleReset() {
    if (!confirm('This will delete the current WhatsApp config so you can re-enter it. Continue?')) {
      return;
    }

    try {
      setResetting(true);
      const res = await fetch('/api/whatsapp/config', { method: 'DELETE' });
      const data = await res.json();

      if (!res.ok) {
        toast.error(data.error || 'Failed to reset configuration');
        return;
      }

      toast.success('Configuration cleared. You can now re-enter your credentials.');
      setConfig(null);
      setPhoneNumberId('');
      setWabaId('');
      setAccessToken('');
      setUazapiBaseUrl('');
      setUazapiToken('');
      setUazapiTokenEdited(false);
      setUazapiQrCode(null);
      setVerifyToken('');
      setTokenEdited(false);
      setConnectionStatus('disconnected');
      setResetReason(null);
      setStatusMessage('');
    } catch (err) {
      console.error('Reset error:', err);
      toast.error('Failed to reset configuration');
    } finally {
      setResetting(false);
    }
  }

  function handleCopyWebhookUrl() {
    navigator.clipboard.writeText(webhookUrl);
    toast.success('Webhook URL copied to clipboard');
  }

  if (loading) {
    return (
      <section className="animate-in fade-in-50 duration-200">
        <SettingsPanelHead
          title={t("title")}
          description={t("description")}
        />
        <div className="flex items-center justify-center py-12">
          <Loader2 className="size-6 animate-spin text-primary" />
        </div>
      </section>
    );
  }

  const showResetBanner = resetReason === 'token_corrupted';
  const activeProvider = config?.provider || (config?.instance_token ? 'uazapi' : 'meta');
  const isUazapiMode = activeProvider === 'uazapi';
  const isEvolutionMode = activeProvider === 'evolution';
  const isUazapiConnected = isUazapiMode && (
    connectionStatus === 'connected' ||
    config?.status === 'connected' ||
    config?.connection_state === 'connected'
  );

  const isEvolutionConnected = isEvolutionMode && (
    connectionStatus === 'connected' ||
    config?.status === 'connected' ||
    config?.connection_state === 'connected'
  );

  return (
    <section className="animate-in fade-in-50 duration-200">
      <SettingsPanelHead
        title={t("title")}
        description="Conecte o WhatsApp pela Meta, UAZAPI ou Evolution API."
      />
      <Tabs value={provider} onValueChange={(value) => setProvider(value as 'meta' | 'uazapi' | 'evolution')} className="mb-4">
        <TabsList>
          <TabsTrigger value="meta">API Oficial (Meta)</TabsTrigger>
          <TabsTrigger value="uazapi">QR Code (UAZAPI)</TabsTrigger>
          <TabsTrigger value="evolution">Evolution API</TabsTrigger>
        </TabsList>
      </Tabs>
      <div className="grid gap-6 lg:grid-cols-[1fr_380px]">
      {/* Main config form */}
      <div className="space-y-6">
        {/* Corrupted-token reset banner */}
        {provider === 'meta' && showResetBanner && (
          <Alert className="bg-amber-950/40 border-amber-600/40">
            <div className="flex items-start gap-3">
              <AlertTriangle className="size-5 text-amber-400 mt-0.5 shrink-0" />
              <div className="flex-1">
                <AlertTitle className="text-amber-200 mb-1">
                  Stored token can&apos;t be decrypted
                </AlertTitle>
                <AlertDescription className="text-amber-100/80 text-sm">
                  {statusMessage}
                </AlertDescription>
                <Button
                  onClick={handleReset}
                  disabled={resetting}
                  size="sm"
                  className="mt-3 bg-amber-600 hover:bg-amber-700 text-white"
                >
                  {resetting ? (
                    <>
                      <Loader2 className="size-4 animate-spin" />
                      {t('resetting')}
                    </>
                  ) : (
                    <>
                      <RotateCcw className="size-4" />
                      {t('resetConfig')}
                    </>
                  )}
                </Button>
              </div>
            </div>
          </Alert>
        )}

        {/* Connection Status */}
        {provider === 'meta' && !isUazapiMode && (
        <Alert className="bg-card border-border">
          <div className="flex items-center gap-2">
            {connectionStatus === 'connected' ? (
              <CheckCircle2 className="size-4 text-primary" />
            ) : (
              <XCircle className="size-4 text-red-500" />
            )}
            <AlertTitle className="text-foreground mb-0">
              {connectionStatus === 'connected'
                ? isUazapiMode ? 'uazapi conectado' : t('credentialsValid')
                : t('notConnected')}
            </AlertTitle>
          </div>
          <AlertDescription className="text-muted-foreground">
            {connectionStatus === 'connected'
              ? isUazapiMode
                ? 'Servidor e token da uazapi salvos. Configure a URL do webhook na uazapi para receber mensagens.'
                : t('connectedDesc')
              : statusMessage ||
                t('notConnectedDesc')}
          </AlertDescription>
        </Alert>
        )}

        {/* Registration Status — the "is it actually live?" check.
            Credentials being valid is necessary but not sufficient;
            without a successful /register call the number won't
            receive inbound events. Surface this dimension separately
            so users don't trust a misleading green banner. */}
        {provider === 'meta' && !isUazapiMode && config && (
          <Alert
            className={
              isRegistered
                ? 'bg-emerald-950/30 border-emerald-700/50'
                : 'bg-amber-950/30 border-amber-700/50'
            }
          >
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <div className="flex items-center gap-2">
                {isRegistered ? (
                  <CheckCircle2 className="size-4 text-emerald-400" />
                ) : (
                  <AlertTriangle className="size-4 text-amber-400" />
                )}
                <AlertTitle
                  className={
                    'mb-0 ' + (isRegistered ? 'text-emerald-200' : 'text-amber-200')
                  }
                >
                  {isRegistered
                    ? t('registered')
                    : t('notRegistered')}
                </AlertTitle>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={handleVerifyRegistration}
                disabled={verifyingRegistration}
                className="border-border bg-transparent text-foreground hover:bg-muted h-7"
              >
                {verifyingRegistration ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Zap className="size-3.5" />
                )}
                {t('verifyWithMeta')}
              </Button>
            </div>
            <AlertDescription className="text-muted-foreground mt-2 text-xs leading-relaxed">
              {isRegistered ? (
                <span
                  dangerouslySetInnerHTML={{
                    __html: t('subscribedSince', {
                      date: config.registered_at
                        ? new Date(config.registered_at).toLocaleString()
                        : t('unknownDate'),
                    }),
                  }}
                />
              ) : lastRegistrationError ? (
                <>
                  {t('lastAttemptFailed')}
                  <span className="text-red-300">
                    &quot;{lastRegistrationError}&quot;
                  </span>
                  . {t('retryHint')}
                </>
              ) : (
                <>{t('noRegistrationHint')}</>
              )}
            </AlertDescription>

            {registrationProbe && (
              <div className="mt-3 rounded border border-border bg-card/60 px-3 py-2 space-y-1.5 text-[11px]">
                <p className="font-medium text-foreground">
                  {t('diagnosticLastRun')}
                  <span className={registrationProbe.live ? 'text-emerald-400' : 'text-amber-400'}>
                    {registrationProbe.live ? t('live') : t('notLive')}
                  </span>
                </p>
                <ul className="space-y-0.5 text-muted-foreground">
                  {Object.entries(registrationProbe.checks).map(([k, v]) => (
                    <li key={k} className="flex items-center gap-1.5">
                      {v === true ? (
                        <CheckCircle2 className="size-3 text-emerald-400 shrink-0" />
                      ) : v === false ? (
                        <XCircle className="size-3 text-red-400 shrink-0" />
                      ) : (
                        <span className="size-3 rounded-full border border-border shrink-0" />
                      )}
                      <code className="text-muted-foreground">{k}</code>
                    </li>
                  ))}
                </ul>
                {(registrationProbe.errors ?? []).length > 0 && (
                  <ul className="pt-1 space-y-0.5 text-red-300">
                    {registrationProbe.errors?.map((e, i) => (
                      <li key={i}>• {e}</li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </Alert>
        )}

        {provider === 'uazapi' && (
        <Card>
          <CardHeader>
            <CardTitle className="text-foreground">UAZAPI Credentials</CardTitle>
            <CardDescription className="text-muted-foreground">
              Conecte via QR Code usando sua instancia UAZAPI.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {isUazapiConnected && (
              <Alert className="border-emerald-700/50 bg-emerald-950/30">
                <CheckCircle2 className="size-4 text-emerald-400" />
                <AlertTitle className="text-emerald-200">UAZAPI conectado</AlertTitle>
                <AlertDescription className="text-emerald-100/80">
                  Esta instancia ja esta conectada. As mensagens entram e saem pela UAZAPI ativa.
                </AlertDescription>
              </Alert>
            )}

            <div className="space-y-2">
              <Label className="text-muted-foreground">Server URL</Label>
              <Input
                placeholder="https://sua-instancia.uazapi.com"
                value={uazapiBaseUrl}
                onChange={(e) => {
                  setUazapiBaseUrl(e.target.value);
                  setUazapiQrCode(null);
                }}
                className="bg-muted border-border text-foreground placeholder:text-muted-foreground"
              />
            </div>

            <div className="space-y-2">
              <Label className="text-muted-foreground">Instance token</Label>
              <div className="relative">
                <Input
                  type={showToken ? 'text' : 'password'}
                  placeholder="Cole o token da instancia uazapi"
                  value={uazapiToken}
                  onChange={(e) => {
                    setUazapiToken(e.target.value);
                    setUazapiTokenEdited(true);
                    setUazapiQrCode(null);
                  }}
                  onFocus={() => {
                    if (uazapiToken === MASKED_TOKEN) {
                      setUazapiToken('');
                      setUazapiTokenEdited(true);
                      setUazapiQrCode(null);
                    }
                  }}
                  className="bg-muted border-border text-foreground placeholder:text-muted-foreground pr-10"
                />
                <button
                  type="button"
                  onClick={() => setShowToken(!showToken)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                >
                  {showToken ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                </button>
              </div>
              {config?.instance_token && !uazapiTokenEdited && (
                <p className="text-xs text-muted-foreground">Token salvo e oculto por seguranca. Reinforme para alterar.</p>
              )}
            </div>

            <div className="flex flex-wrap gap-2">
              <Button
                onClick={handleSaveUazapi}
                disabled={saving}
                className="bg-primary hover:bg-primary/90 text-primary-foreground"
              >
                {saving ? (
                  <>
                    <Loader2 className="size-4 animate-spin" />
                    Conectando...
                  </>
                ) : (
                  config?.instance_token ? 'Salvar UAZAPI' : 'Conectar'
                )}
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={handleGenerateUazapiQr}
                disabled={qrLoading || saving}
                className="border-border text-muted-foreground hover:text-foreground hover:bg-muted"
              >
                {qrLoading ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <QrCodeIcon className="size-4" />
                )}
                {uazapiQrCode ? 'Atualizar QR Code' : 'Gerar QR Code'}
              </Button>
            </div>

            {!isUazapiConnected && uazapiQrCode && (
              <div className="rounded-lg border border-border bg-muted/40 p-4">
                <div className="flex flex-col items-center gap-3 text-center">
                  <img
                    src={uazapiQrCode}
                    alt="QR Code UAZAPI para conectar WhatsApp"
                    className="size-56 rounded-md border border-border bg-white p-2"
                  />
                  <p className="text-sm text-muted-foreground">
                    Abra o WhatsApp no celular, toque em Aparelhos conectados e escaneie este QR Code.
                  </p>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
        )}

        {provider === 'evolution' && (
          <Card>
            <CardHeader>
              <CardTitle className="text-foreground">Evolution API</CardTitle>
              <CardDescription className="text-muted-foreground">
                Crie uma nova instância, configure o webhook e conecte o WhatsApp sem sair do AutoIA CRM.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {isEvolutionConnected && (
                <Alert className="border-emerald-700/50 bg-emerald-950/30">
                  <CheckCircle2 className="size-4 text-emerald-400" />
                  <AlertTitle className="text-emerald-200">Evolution conectada</AlertTitle>
                  <AlertDescription className="text-emerald-100/80">
                    A instância está online e o Inbox usa a Evolution para enviar e receber mensagens.
                  </AlertDescription>
                </Alert>
              )}

              <div className="space-y-2">
                <Label className="text-muted-foreground">URL do servidor</Label>
                <Input
                  placeholder="https://evolution.seudominio.com"
                  value={evolutionBaseUrl}
                  onChange={(event) => {
                    setEvolutionBaseUrl(event.target.value);
                    setEvolutionQrCode(null);
                  }}
                />
              </div>

              <div className="space-y-2">
                <Label className="text-muted-foreground">Nome da nova instância</Label>
                <Input
                  placeholder="autoia-atendimento"
                  value={evolutionInstanceName}
                  onChange={(event) => {
                    setEvolutionInstanceName(event.target.value);
                    setEvolutionQrCode(null);
                  }}
                />
                <p className="text-xs text-muted-foreground">
                  Use letras, números, hífen ou underline. O CRM criará esta instância na Evolution.
                </p>
              </div>

              <div className="space-y-2">
                <Label className="text-muted-foreground">API Key global</Label>
                <div className="relative">
                  <Input
                    type={showToken ? 'text' : 'password'}
                    placeholder="Cole a API Key global da Evolution"
                    value={evolutionApiKey}
                    onChange={(event) => {
                      setEvolutionApiKey(event.target.value);
                      setEvolutionApiKeyEdited(true);
                      setEvolutionQrCode(null);
                    }}
                    onFocus={() => {
                      if (evolutionApiKey === MASKED_TOKEN) {
                        setEvolutionApiKey('');
                        setEvolutionApiKeyEdited(true);
                      }
                    }}
                    className="pr-10"
                  />
                  <button
                    type="button"
                    onClick={() => setShowToken(!showToken)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    aria-label={showToken ? 'Ocultar API Key' : 'Mostrar API Key'}
                  >
                    {showToken ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                  </button>
                </div>
                {config?.provider === 'evolution' && !evolutionApiKeyEdited && (
                  <p className="text-xs text-muted-foreground">API Key salva e protegida. Reinforme apenas para alterá-la.</p>
                )}
              </div>

              <Button onClick={handleConnectEvolution} disabled={qrLoading}>
                {qrLoading ? <Loader2 className="size-4 animate-spin" /> : <QrCodeIcon className="size-4" />}
                {isEvolutionConnected
                  ? 'Verificar conexão'
                  : evolutionQrCode
                    ? 'Atualizar QR Code'
                    : 'Criar instância e gerar QR Code'}
              </Button>

              {!isEvolutionConnected && evolutionQrCode && (
                <div className="rounded-lg border border-border bg-muted/40 p-4">
                  <div className="flex flex-col items-center gap-3 text-center">
                    <img
                      src={evolutionQrCode}
                      alt="QR Code da Evolution para conectar o WhatsApp"
                      className="size-56 rounded-md border border-border bg-white p-2"
                    />
                    <p className="text-sm text-muted-foreground">
                      No WhatsApp, abra Aparelhos conectados e escaneie o QR Code.
                    </p>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        )}
        {/* API Credentials */}
        {provider === 'meta' && (
        <Card>
          <CardHeader>
            <CardTitle className="text-foreground">{t('apiCredentialsTitle')}</CardTitle>
            <CardDescription className="text-muted-foreground">
              {t('apiCredentialsDesc')}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label className="text-muted-foreground">{t('phoneNumberId')}</Label>
              <Input
                placeholder="e.g. 100234567890123"
                value={phoneNumberId}
                onChange={(e) => setPhoneNumberId(e.target.value)}
                className="bg-muted border-border text-foreground placeholder:text-muted-foreground"
              />
            </div>

            <div className="space-y-2">
              <Label className="text-muted-foreground">{t('wabaId')}</Label>
              <Input
                placeholder="e.g. 100234567890456"
                value={wabaId}
                onChange={(e) => setWabaId(e.target.value)}
                className="bg-muted border-border text-foreground placeholder:text-muted-foreground"
              />
            </div>

            <div className="space-y-2">
              <Label className="text-muted-foreground">{t('accessToken')}</Label>
              <div className="relative">
                <Input
                  type={showToken ? 'text' : 'password'}
                  placeholder={t('accessTokenPlaceholder')}
                  value={accessToken}
                  onChange={(e) => {
                    setAccessToken(e.target.value);
                    setTokenEdited(true);
                  }}
                  onFocus={() => {
                    if (accessToken === MASKED_TOKEN) {
                      setAccessToken('');
                      setTokenEdited(true);
                    }
                  }}
                  className="bg-muted border-border text-foreground placeholder:text-muted-foreground pr-10"
                />
                <button
                  type="button"
                  onClick={() => setShowToken(!showToken)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                >
                  {showToken ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                </button>
              </div>
              {config && !tokenEdited && (
                <p className="text-xs text-muted-foreground">
                  {t('tokenHidden')}
                </p>
              )}
            </div>

            <div className="space-y-2">
              <Label className="text-muted-foreground">{t('webhookVerifyToken')}</Label>
              <Input
                placeholder={t('webhookVerifyTokenPlaceholder')}
                value={verifyToken}
                onChange={(e) => setVerifyToken(e.target.value)}
                className="bg-muted border-border text-foreground placeholder:text-muted-foreground"
              />
              <p className="text-xs text-muted-foreground">
                {t('webhookVerifyTokenHint')}
              </p>
            </div>

            <div className="space-y-2">
              <Label className="text-muted-foreground">
                {t('twoStepPin')}
                <span className="ml-1 text-muted-foreground">{t('optional')}</span>
              </Label>
              <Input
                type="text"
                inputMode="numeric"
                maxLength={6}
                placeholder={t('pinPlaceholder')}
                value={pin}
                onChange={(e) =>
                  setPin(e.target.value.replace(/\D/g, '').slice(0, 6))
                }
                className="bg-muted border-border text-foreground placeholder:text-muted-foreground tracking-widest"
              />
              <p className="text-xs text-muted-foreground leading-relaxed">
                <span dangerouslySetInnerHTML={{ __html: t('pinHint') }} />
              </p>
            </div>
          </CardContent>
        </Card>
        )}

        {/* Webhook URL */}
        {provider === 'meta' && (
        <Card>
          <CardHeader>
            <CardTitle className="text-foreground">{t('webhookTitle')}</CardTitle>
            <CardDescription className="text-muted-foreground">
              {t('webhookDesc')}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              <Label className="text-muted-foreground">{t('webhookUrl')}</Label>
              <div className="flex gap-2">
                <Input
                  readOnly
                  value={webhookUrl}
                  className="bg-muted border-border text-muted-foreground font-mono text-sm"
                />
                <Button
                  variant="outline"
                  size="icon"
                  onClick={handleCopyWebhookUrl}
                  className="shrink-0 border-border text-muted-foreground hover:text-foreground hover:bg-muted"
                >
                  <Copy className="size-4" />
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
        )}

        {/* Action Buttons */}
        {provider === 'meta' && (
        <div className="flex flex-wrap gap-3">
          <>
          <Button
            onClick={handleSave}
            disabled={saving}
            className="bg-primary hover:bg-primary/90 text-primary-foreground"
          >
            {saving ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                {t('saving')}
              </>
            ) : (
              t('saveConfig')
            )}
          </Button>
          </>
          <Button
            variant="outline"
            onClick={handleTestConnection}
            disabled={testing || !config}
            className="border-border text-muted-foreground hover:text-foreground hover:bg-muted"
          >
            {testing ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                {t('testing')}
              </>
            ) : (
              <>
                <Zap className="size-4" />
                {t('testConnection')}
              </>
            )}
          </Button>
          {config && (
            <Button
              variant="outline"
              onClick={handleReset}
              disabled={resetting}
              className="border-red-900 text-red-400 hover:text-red-300 hover:bg-red-950/40"
            >
              {resetting ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  {t('resetting')}
                </>
              ) : (
                <>
                  <RotateCcw className="size-4" />
                  {t('resetConfig')}
                </>
              )}
            </Button>
          )}
        </div>
        )}
      </div>

      {/* Setup Instructions Sidebar */}
      <div>
        {provider === 'uazapi' ? (
          <Card>
            <CardHeader>
              <CardTitle className="text-foreground text-base">Proximos passos uazapi</CardTitle>
              <CardDescription className="text-muted-foreground">
                A conexao da Meta nao e usada quando a uazapi esta ativa.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3 text-sm text-muted-foreground">
              <p>Configure na uazapi esta URL de webhook:</p>
              <code className="block rounded-md bg-muted p-2 text-xs text-foreground break-all">{uazapiWebhookUrl}</code>
              <p>Troque <code>SEU_TOKEN_DA_VERCEL</code> pelo mesmo valor da variavel <code>UAZAPI_WEBHOOK_TOKEN</code> configurada na Vercel. Depois envie uma mensagem para o numero conectado e veja se ela aparece na caixa de entrada.</p>
            </CardContent>
          </Card>
        ) : provider === 'evolution' ? (
          <Card>
            <CardHeader>
              <CardTitle className="text-foreground text-base">Conexão automática</CardTitle>
              <CardDescription className="text-muted-foreground">
                O AutoIA CRM cuida da configuração técnica da Evolution.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3 text-sm text-muted-foreground">
              <p>Ao clicar em criar instância, o CRM:</p>
              <p>1. cria ou reutiliza a instância informada;</p>
              <p>2. cadastra o webhook seguro desta conta;</p>
              <p>3. mostra o QR Code para conectar o WhatsApp.</p>
              <p>Depois da leitura do QR Code, use o botão novamente para confirmar o estado da conexão.</p>
            </CardContent>
          </Card>
        ) : (
        <Card>
          <CardHeader>
            <CardTitle className="text-foreground text-base">{t('setupInstructions')}</CardTitle>
            <CardDescription className="text-muted-foreground">
              {t('setupInstructionsDesc')}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Accordion>
              <AccordionItem className="border-border">
                <AccordionTrigger className="text-muted-foreground hover:text-foreground hover:no-underline">
                  <span className="flex items-center gap-2">
                    <span className="flex size-5 items-center justify-center rounded-full bg-primary text-xs font-bold text-primary-foreground">1</span>
                    {t('step1')}
                  </span>
                </AccordionTrigger>
                <AccordionContent className="text-muted-foreground">
                  <ol className="list-decimal list-inside space-y-1 text-sm">
                    <li dangerouslySetInnerHTML={{ __html: t('step1_1') }} />
                    <li>{t('step1_2')}</li>
                    <li>{t('step1_3')}</li>
                    <li>{t('step1_4')}</li>
                  </ol>
                </AccordionContent>
              </AccordionItem>

              <AccordionItem className="border-border">
                <AccordionTrigger className="text-muted-foreground hover:text-foreground hover:no-underline">
                  <span className="flex items-center gap-2">
                    <span className="flex size-5 items-center justify-center rounded-full bg-primary text-xs font-bold text-primary-foreground">2</span>
                    {t('step2')}
                  </span>
                </AccordionTrigger>
                <AccordionContent className="text-muted-foreground">
                  <ol className="list-decimal list-inside space-y-1 text-sm">
                    <li>{t('step2_1')}</li>
                    <li>{t('step2_2')}</li>
                    <li>{t('step2_3')}</li>
                  </ol>
                </AccordionContent>
              </AccordionItem>

              <AccordionItem className="border-border">
                <AccordionTrigger className="text-muted-foreground hover:text-foreground hover:no-underline">
                  <span className="flex items-center gap-2">
                    <span className="flex size-5 items-center justify-center rounded-full bg-primary text-xs font-bold text-primary-foreground">3</span>
                    {t('step3')}
                  </span>
                </AccordionTrigger>
                <AccordionContent className="text-muted-foreground">
                  <ol className="list-decimal list-inside space-y-1 text-sm">
                    <li>{t('step3_1')}</li>
                    <li dangerouslySetInnerHTML={{ __html: t('step3_2') }} />
                    <li dangerouslySetInnerHTML={{ __html: t('step3_3') }} />
                    <li dangerouslySetInnerHTML={{ __html: t('step3_4') }} />
                  </ol>
                </AccordionContent>
              </AccordionItem>

              <AccordionItem className="border-border">
                <AccordionTrigger className="text-muted-foreground hover:text-foreground hover:no-underline">
                  <span className="flex items-center gap-2">
                    <span className="flex size-5 items-center justify-center rounded-full bg-primary text-xs font-bold text-primary-foreground">4</span>
                    {t('step4')}
                  </span>
                </AccordionTrigger>
                <AccordionContent className="text-muted-foreground">
                  <ol className="list-decimal list-inside space-y-1 text-sm">
                    <li>{t('step4_1')}</li>
                    <li>{t('step4_2')}</li>
                    <li dangerouslySetInnerHTML={{ __html: t('step4_3') }} />
                    <li dangerouslySetInnerHTML={{ __html: t('step4_4') }} />
                    <li>{t('step4_5')}</li>
                  </ol>
                </AccordionContent>
              </AccordionItem>
            </Accordion>

            <div className="mt-4 pt-4 border-t border-border">
              <a
                href="https://developers.facebook.com/docs/whatsapp/cloud-api/get-started"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 text-sm text-primary hover:text-primary/80 transition-colors"
              >
                <ExternalLink className="size-3.5" />
                {t('metaDocs')}
              </a>
            </div>
          </CardContent>
        </Card>
        )}
      </div>
    </div>
    </section>
  );
}

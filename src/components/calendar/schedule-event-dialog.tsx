"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { CalendarPlus, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { fetchAccountMembers, memberLabel } from "@/lib/account/members";
import type { AccountMember } from "@/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface ContactOption {
  id: string;
  name: string | null;
  phone: string | null;
}

interface ScheduleEventDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  contact?: ContactOption | null;
  conversationId?: string | null;
  defaultTitle?: string;
  defaultNote?: string;
  aiSuggested?: boolean;
  onSaved?: () => void;
}

const NONE = "__none__";

function localDateTimeValue(date = new Date(Date.now() + 60 * 60 * 1000)) {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function ScheduleEventDialog({
  open,
  onOpenChange,
  contact,
  conversationId,
  defaultTitle = "Retorno comercial",
  defaultNote = "",
  aiSuggested = false,
  onSaved,
}: ScheduleEventDialogProps) {
  const { accountId, user } = useAuth();
  const [title, setTitle] = useState(defaultTitle);
  const [startsAt, setStartsAt] = useState(localDateTimeValue());
  const [note, setNote] = useState(defaultNote);
  const [assignedTo, setAssignedTo] = useState<string>(user?.id ?? NONE);
  const [contactId, setContactId] = useState(contact?.id ?? "");
  const [contacts, setContacts] = useState<ContactOption[]>([]);
  const [members, setMembers] = useState<AccountMember[]>([]);
  const [saving, setSaving] = useState(false);

  const fixedContact = Boolean(contact?.id);
  const selectedContact = useMemo(
    () => contact ?? contacts.find((c) => c.id === contactId) ?? null,
    [contact, contacts, contactId],
  );

  useEffect(() => {
    if (!open) return;
    setTitle(defaultTitle);
    setNote(defaultNote);
    setStartsAt(localDateTimeValue());
    setAssignedTo(user?.id ?? NONE);
    setContactId(contact?.id ?? "");
  }, [open, defaultTitle, defaultNote, user?.id, contact?.id]);

  useEffect(() => {
    if (!open || fixedContact || !accountId) return;
    const supabase = createClient();
    supabase
      .from("contacts")
      .select("id, name, phone")
      .eq("account_id", accountId)
      .order("updated_at", { ascending: false })
      .limit(100)
      .then(({ data }) => setContacts((data ?? []) as ContactOption[]));
  }, [open, fixedContact, accountId]);

  useEffect(() => {
    if (!open) return;
    void fetchAccountMembers().then(setMembers);
  }, [open]);

  const save = useCallback(async () => {
    if (!accountId || !user?.id) return;
    if (!title.trim()) return toast.error("Informe um titulo.");
    if (!contactId) return toast.error("Selecione um contato.");
    if (!startsAt) return toast.error("Informe data e hora.");

    setSaving(true);
    const supabase = createClient();
    const { error } = await supabase.from("calendar_events").insert({
      account_id: accountId,
      user_id: user.id,
      assigned_to: assignedTo === NONE ? null : assignedTo,
      contact_id: contactId,
      conversation_id: conversationId ?? null,
      title: title.trim(),
      starts_at: new Date(startsAt).toISOString(),
      note: note.trim() || null,
      ai_suggested: aiSuggested,
    });
    setSaving(false);

    if (error) {
      toast.error("Nao foi possivel agendar.");
      return;
    }
    toast.success("Agendamento criado.");
    onSaved?.();
    onOpenChange(false);
  }, [accountId, user?.id, title, contactId, startsAt, assignedTo, conversationId, note, aiSuggested, onSaved, onOpenChange]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <CalendarPlus className="h-4 w-4 text-primary" /> Agendar retorno
          </DialogTitle>
          <DialogDescription>Crie um lembrete interno vinculado ao atendimento.</DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
          <div className="space-y-2">
            <Label>Titulo</Label>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label>Data e hora</Label>
              <Input type="datetime-local" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label>Responsavel</Label>
              <Select value={assignedTo} onValueChange={(value) => value && setAssignedTo(value)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>Sem responsavel</SelectItem>
                  {members.map((member) => (
                    <SelectItem key={member.user_id} value={member.user_id}>{memberLabel(member)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-2">
            <Label>Contato</Label>
            {fixedContact ? (
              <div className="rounded-md border border-border bg-muted px-3 py-2 text-sm text-muted-foreground">
                {selectedContact?.name || selectedContact?.phone}
              </div>
            ) : (
              <Select value={contactId || undefined} onValueChange={(value) => value && setContactId(value)}>
                <SelectTrigger><SelectValue placeholder="Selecione um contato" /></SelectTrigger>
                <SelectContent>
                  {contacts.map((item) => (
                    <SelectItem key={item.id} value={item.id}>{item.name || item.phone}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>

          <div className="space-y-2">
            <Label>Observacao</Label>
            <Textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Contexto do retorno, combinados ou proximo passo..." />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>Cancelar</Button>
          <Button onClick={save} disabled={saving}>
            {saving && <Loader2 className="h-4 w-4 animate-spin" />}
            Agendar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

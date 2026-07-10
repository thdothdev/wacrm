"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { CalendarDays, CalendarPlus, CheckCircle2, Clock, Loader2, XCircle } from "lucide-react";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { fetchAccountMembers, memberLabel } from "@/lib/account/members";
import type { AccountMember, CalendarEvent, CalendarEventStatus } from "@/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScheduleEventDialog } from "@/components/calendar/schedule-event-dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

const ALL = "all";

function todayValue() {
  return new Date().toISOString().slice(0, 10);
}

function endOfDay(date: string) {
  return new Date(`${date}T23:59:59`).toISOString();
}

function startOfDay(date: string) {
  return new Date(`${date}T00:00:00`).toISOString();
}

function addDays(date: string, days: number) {
  const d = new Date(`${date}T00:00:00`);
  d.setDate(d.getDate() + days);
  return d.toISOString();
}

function eventState(event: CalendarEvent) {
  if (event.status !== "pending") return event.status;
  const time = new Date(event.starts_at).getTime();
  const now = Date.now();
  if (time < now) return "overdue";
  if (time <= now + 60 * 60 * 1000) return "soon";
  return "pending";
}

export default function CalendarPage() {
  const { accountId } = useAuth();
  const [events, setEvents] = useState<CalendarEvent[] | null>(null);
  const [members, setMembers] = useState<AccountMember[]>([]);
  const [date, setDate] = useState(todayValue());
  const [status, setStatus] = useState<string>(ALL);
  const [assignee, setAssignee] = useState<string>(ALL);
  const [range, setRange] = useState<"day" | "week">("day");
  const [dialogOpen, setDialogOpen] = useState(false);

  const load = useCallback(async () => {
    if (!accountId) return;
    const supabase = createClient();
    void supabase.rpc("notify_due_calendar_events");

    let query = supabase
      .from("calendar_events")
      .select("*, contact:contacts(id, name, phone)")
      .eq("account_id", accountId)
      .gte("starts_at", startOfDay(date))
      .lte("starts_at", range === "day" ? endOfDay(date) : addDays(date, 7))
      .order("starts_at", { ascending: true });

    if (status !== ALL) query = query.eq("status", status);
    if (assignee !== ALL) query = query.eq("assigned_to", assignee);

    const { data, error } = await query;
    if (error) {
      toast.error("Nao foi possivel carregar a agenda.");
      setEvents([]);
      return;
    }
    setEvents((data ?? []) as CalendarEvent[]);
  }, [accountId, date, range, status, assignee]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void fetchAccountMembers().then(setMembers);
  }, []);

  const counts = useMemo(() => {
    const list = events ?? [];
    return {
      overdue: list.filter((event) => eventState(event) === "overdue").length,
      soon: list.filter((event) => eventState(event) === "soon").length,
      pending: list.filter((event) => event.status === "pending").length,
    };
  }, [events]);

  const updateStatus = useCallback(async (event: CalendarEvent, next: CalendarEventStatus) => {
    setEvents((prev) => prev?.map((item) => item.id === event.id ? { ...item, status: next } : item) ?? prev);
    const supabase = createClient();
    const { error } = await supabase
      .from("calendar_events")
      .update({ status: next, updated_at: new Date().toISOString() })
      .eq("id", event.id);
    if (error) {
      toast.error("Nao foi possivel atualizar o evento.");
      void load();
    }
  }, [load]);

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Agenda</h1>
          <p className="mt-1 text-sm text-muted-foreground">Retornos, reunioes e follow-ups comerciais.</p>
        </div>
        <Button onClick={() => setDialogOpen(true)}>
          <CalendarPlus className="h-4 w-4" /> Novo agendamento
        </Button>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <Metric label="Pendentes" value={counts.pending} icon={Clock} />
        <Metric label="Proximos" value={counts.soon} icon={CalendarDays} tone="primary" />
        <Metric label="Vencidos" value={counts.overdue} icon={XCircle} tone="danger" />
      </div>

      <div className="flex flex-col gap-2 rounded-lg border border-border bg-card p-3 sm:flex-row sm:items-end">
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground">Data</label>
          <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </div>
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground">Periodo</label>
          <Select value={range} onValueChange={(v) => setRange(v as "day" | "week")}>
            <SelectTrigger className="w-36"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="day">Dia</SelectItem>
              <SelectItem value="week">Semana</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground">Status</label>
          <Select value={status} onValueChange={(value) => value && setStatus(value)}>
            <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>Todos</SelectItem>
              <SelectItem value="pending">Pendente</SelectItem>
              <SelectItem value="done">Concluido</SelectItem>
              <SelectItem value="cancelled">Cancelado</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground">Responsavel</label>
          <Select value={assignee} onValueChange={(value) => value && setAssignee(value)}>
            <SelectTrigger className="w-56"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>Todos</SelectItem>
              {members.map((member) => <SelectItem key={member.user_id} value={member.user_id}>{memberLabel(member)}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
      </div>

      {events === null ? (
        <div className="flex h-48 items-center justify-center"><Loader2 className="h-6 w-6 animate-spin text-primary" /></div>
      ) : events.length === 0 ? (
        <div className="flex h-48 flex-col items-center justify-center rounded-xl border border-dashed border-border bg-muted/40 text-center">
          <CalendarDays className="h-8 w-8 text-muted-foreground" />
          <p className="mt-3 text-sm font-medium text-foreground">Nenhum evento encontrado</p>
          <p className="mt-1 text-xs text-muted-foreground">Crie um retorno ou ajuste os filtros.</p>
        </div>
      ) : (
        <ul className="space-y-2">
          {events.map((event) => (
            <EventRow key={event.id} event={event} onStatus={updateStatus} />
          ))}
        </ul>
      )}

      <ScheduleEventDialog open={dialogOpen} onOpenChange={setDialogOpen} onSaved={load} />
    </div>
  );
}

function Metric({ label, value, icon: Icon, tone = "muted" }: { label: string; value: number; icon: typeof Clock; tone?: "muted" | "primary" | "danger" }) {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <p className="flex items-center gap-2 text-xs text-muted-foreground"><Icon className={cn("h-4 w-4", tone === "primary" && "text-primary", tone === "danger" && "text-destructive")} /> {label}</p>
      <p className="mt-1 text-2xl font-semibold text-foreground">{value}</p>
    </div>
  );
}

function EventRow({ event, onStatus }: { event: CalendarEvent; onStatus: (event: CalendarEvent, next: CalendarEventStatus) => void }) {
  const state = eventState(event);
  const contactName = event.contact?.name || event.contact?.phone || "Contato";
  return (
    <li className="rounded-xl border border-border bg-card p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <p className="font-semibold text-foreground">{event.title}</p>
            <StatusBadge state={state} />
            {event.ai_suggested && <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-semibold text-primary">Sugestao IA</span>}
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            {new Date(event.starts_at).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" })} - {contactName}
          </p>
          {event.note && <p className="mt-2 whitespace-pre-wrap text-sm text-muted-foreground">{event.note}</p>}
          <div className="mt-2 flex flex-wrap gap-2 text-xs">
            {event.conversation_id && <Link className="text-primary hover:underline" href={`/inbox?c=${event.conversation_id}`}>Abrir conversa</Link>}
          </div>
        </div>
        <div className="flex gap-2">
          {event.status === "pending" && <Button size="sm" variant="outline" onClick={() => onStatus(event, "done")}><CheckCircle2 className="h-4 w-4" /> Concluir</Button>}
          {event.status !== "cancelled" && <Button size="sm" variant="outline" onClick={() => onStatus(event, "cancelled")}>Cancelar</Button>}
        </div>
      </div>
    </li>
  );
}

function StatusBadge({ state }: { state: string }) {
  const map: Record<string, string> = {
    pending: "border-border text-muted-foreground",
    soon: "border-primary/40 bg-primary/10 text-primary",
    overdue: "border-destructive/40 bg-destructive/10 text-destructive",
    done: "border-green-500/40 bg-green-500/10 text-green-600",
    cancelled: "border-muted text-muted-foreground line-through",
  };
  const label: Record<string, string> = {
    pending: "Pendente",
    soon: "Proximo",
    overdue: "Vencido",
    done: "Concluido",
    cancelled: "Cancelado",
  };
  return <span className={cn("rounded-full border px-2 py-0.5 text-[10px] font-semibold", map[state])}>{label[state]}</span>;
}

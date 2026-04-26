/**
 * WD9 · Admin · Domain Context Packs
 *
 * Lists every authored Marico/FMCG knowledge pack and lets an admin toggle
 * each one on or off. Toggle state lives in Cosmos and is honoured on every
 * subsequent chat turn (the server-side loader cache is invalidated on PATCH).
 *
 * The page mirrors AdminCosts.tsx for layout, error handling and the
 * ADMIN_EMAILS-gated 403 path.
 */

import { useEffect, useMemo, useState } from "react";
import {
  fetchDomainContextPacks,
  setDomainContextPackEnabled,
  type DomainContextPacksSnapshot,
  type DomainContextPackSummary,
} from "@/lib/api/admin";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";

const TOKEN_BUDGET_WARN = 12_000;

const CATEGORY_LABEL: Record<string, string> = {
  products: "Marico Products",
  industry: "FMCG Industry",
  competition: "Competition",
  seasonality: "Seasonality",
  events: "Events & Inputs",
  glossary: "Glossary",
};

function formatInt(n: number): string {
  return n.toLocaleString("en-US");
}

interface PendingState {
  packId: string;
  next: boolean;
}

export default function AdminContextPacks() {
  const [data, setData] = useState<DomainContextPacksSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState<PendingState | null>(null);
  const [rowError, setRowError] = useState<{ packId: string; message: string } | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const snap = await fetchDomainContextPacks();
      setData(snap);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const grouped = useMemo(() => {
    if (!data) return [] as Array<{ category: string; packs: DomainContextPackSummary[] }>;
    const map = new Map<string, DomainContextPackSummary[]>();
    for (const p of data.packs) {
      if (!map.has(p.category)) map.set(p.category, []);
      map.get(p.category)!.push(p);
    }
    return Array.from(map.entries()).map(([category, packs]) => ({
      category,
      packs: packs.slice().sort((a, b) => a.priority - b.priority),
    }));
  }, [data]);

  const handleToggle = async (pack: DomainContextPackSummary, next: boolean) => {
    if (!data) return;
    setRowError(null);
    setPending({ packId: pack.id, next });
    // Optimistic local update so the switch responds instantly.
    const optimistic: DomainContextPacksSnapshot = {
      ...data,
      packs: data.packs.map((p) => (p.id === pack.id ? { ...p, enabled: next } : p)),
    };
    setData(optimistic);
    try {
      const res = await setDomainContextPackEnabled(pack.id, next);
      // Reconcile with server-reported total tokens (and the canonical pack row).
      setData({
        ...optimistic,
        totalEnabledTokens: res.totalEnabledTokens,
        packs: optimistic.packs.map((p) => (p.id === pack.id ? res.pack : p)),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Roll back the optimistic toggle.
      setData(data);
      setRowError({ packId: pack.id, message });
    } finally {
      setPending(null);
    }
  };

  if (loading && !data) {
    return (
      <div className="p-6 text-muted-foreground" data-testid="admin-context-packs-loading">
        Loading domain context packs…
      </div>
    );
  }

  if (error) {
    const isForbidden = /\b403\b/.test(error);
    return (
      <div className="p-6">
        <Card className="p-6 border-destructive/30">
          <h2 className="text-lg font-semibold text-foreground mb-2">
            {isForbidden ? "Not authorized" : "Failed to load domain context packs"}
          </h2>
          <p className="text-sm text-muted-foreground mb-4">
            {isForbidden
              ? "Your account isn't on the ADMIN_EMAILS allow-list."
              : error}
          </p>
          <Button onClick={() => void load()} variant="outline">
            Retry
          </Button>
        </Card>
      </div>
    );
  }

  if (!data) return null;

  const overBudget = data.totalEnabledTokens > TOKEN_BUDGET_WARN;
  const enabledCount = data.packs.filter((p) => p.enabled).length;

  return (
    <div className="p-6 space-y-6 max-w-5xl mx-auto">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-foreground">Domain context packs</h1>
          <p className="text-sm text-muted-foreground">
            Marico / FMCG background context injected into every analytical
            chat turn. Toggle a pack to include or exclude it.
          </p>
        </div>
        <Button onClick={() => void load()} variant="outline" size="sm" disabled={loading}>
          {loading ? "Refreshing…" : "Refresh"}
        </Button>
      </header>

      <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
        <Card className="p-4">
          <div className="text-xs text-muted-foreground uppercase tracking-wide">
            Packs enabled
          </div>
          <div className="text-2xl font-semibold text-foreground mt-1">
            {enabledCount} <span className="text-base text-muted-foreground">/ {data.packs.length}</span>
          </div>
        </Card>
        <Card className="p-4">
          <div className="text-xs text-muted-foreground uppercase tracking-wide">
            Approx tokens
          </div>
          <div className="text-2xl font-semibold text-foreground mt-1 flex items-baseline gap-2">
            {formatInt(data.totalEnabledTokens)}
            {overBudget ? (
              <span className="text-xs px-2 py-0.5 rounded-full bg-destructive/15 text-destructive font-medium">
                over {formatInt(TOKEN_BUDGET_WARN)} warn
              </span>
            ) : null}
          </div>
        </Card>
        <Card className="p-4">
          <div className="text-xs text-muted-foreground uppercase tracking-wide">Categories</div>
          <div className="text-2xl font-semibold text-foreground mt-1">
            {grouped.length}
          </div>
        </Card>
      </div>

      {grouped.map(({ category, packs }) => (
        <Card key={category} className="p-4">
          <h2 className="text-base font-semibold text-foreground mb-3">
            {CATEGORY_LABEL[category] ?? category}
          </h2>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-muted-foreground">
                  <th className="py-2 pr-4">Pack</th>
                  <th className="py-2 pr-4">Version</th>
                  <th className="py-2 pr-4 text-right">~tokens</th>
                  <th className="py-2 text-right">Enabled</th>
                </tr>
              </thead>
              <tbody>
                {packs.map((p) => {
                  const isPending = pending?.packId === p.id;
                  const rowErrMatch = rowError?.packId === p.id;
                  return (
                    <tr key={p.id} className="border-t border-border align-top">
                      <td className="py-2 pr-4">
                        <div className="font-medium text-foreground">{p.title}</div>
                        <div className="font-mono text-xs text-muted-foreground">{p.id}</div>
                        {rowErrMatch ? (
                          <div className="text-xs text-destructive mt-1">{rowError!.message}</div>
                        ) : null}
                      </td>
                      <td className="py-2 pr-4 text-muted-foreground font-mono text-xs">
                        {p.version}
                      </td>
                      <td className="py-2 pr-4 text-right tabular-nums text-muted-foreground">
                        {formatInt(p.approxTokens)}
                      </td>
                      <td className="py-2 text-right">
                        <Switch
                          checked={p.enabled}
                          disabled={isPending}
                          onCheckedChange={(next) => void handleToggle(p, next)}
                          aria-label={`Toggle ${p.title}`}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      ))}
    </div>
  );
}

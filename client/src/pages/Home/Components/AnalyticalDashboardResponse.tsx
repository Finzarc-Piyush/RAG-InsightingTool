import { lazy, Suspense, useState, useMemo } from 'react';
import { useLocation } from 'wouter';
import {
  Message,
  ChartSpec,
  ThinkingStep,
  TemporalDisplayGrain,
  type TemporalFacetColumnMeta,
} from '@/shared/schema';
import { MagnitudesRow, type MagnitudeItem } from './MagnitudesRow';
import { InsightCard } from './InsightCard';
import { Settle } from '@/components/ui/motion';
import { MarkdownRenderer } from '@/components/ui/markdown-renderer';
import { DataPreviewTable } from './DataPreviewTable';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { dashboardsApi } from '@/lib/api/dashboards';
import { splitAssistantFollowUpPrompts } from '@/lib/chat/splitAssistantFollowUpPrompts';
import { cn } from '@/lib/utils';
import { useToast } from '@/hooks/use-toast';
import {
  LayoutDashboard,
  Loader2,
  TrendingUp,
  BarChart2,
  PieChart,
  Crosshair,
  LayoutGrid,
  Table2,
  Filter,
} from 'lucide-react';

const ChartRenderer = lazy(() =>
  import('./ChartRenderer').then((m) => ({ default: m.ChartRenderer }))
);

// ---- helpers ---------------------------------------------------------------

function stripAgentChartMeta(chart: ChartSpec): ChartSpec {
  const { _agentEvidenceRef: _e, _agentTurnId: _t, ...rest } = chart as ChartSpec & {
    _agentEvidenceRef?: string;
    _agentTurnId?: string;
  };
  return rest as ChartSpec;
}

function isFullWidthChart(chart: ChartSpec): boolean {
  if (chart.type === 'line' || chart.type === 'area' || chart.type === 'heatmap') return true;
  if (chart.type === 'bar' && (chart.data?.length ?? 0) > 10) return true;
  return false;
}

function extractCorrelationLoadingState(
  chart: ChartSpec,
  thinkingSteps: ThinkingStep[],
): { isLoading: boolean; progress?: { processed: number; total: number; message?: string } } {
  const isCorrelation = chart.type === 'scatter' && (chart as any)._isCorrelationChart;
  if (!isCorrelation) return { isLoading: false };
  if (chart.data && chart.data.length > 0) return { isLoading: false };

  const relevant = thinkingSteps.filter(
    (s) =>
      s.step.toLowerCase().includes('correlation') ||
      s.step.toLowerCase().includes('computing'),
  );
  const active = relevant.find((s) => s.status === 'active');
  if (!active) return { isLoading: false };

  let progress: { processed: number; total: number; message?: string } | undefined;
  if (active.details) {
    const m = active.details.match(/(\d+(?:,\d+)*)\/(\d+(?:,\d+)*)\s*rows/i);
    if (m) {
      const processed = parseInt(m[1].replace(/,/g, ''), 10);
      const total = parseInt(m[2].replace(/,/g, ''), 10);
      if (!isNaN(processed) && !isNaN(total))
        progress = { processed, total, message: active.step };
    }
  }
  return {
    isLoading: true,
    progress: progress ?? { processed: 0, total: 0, message: active.step },
  };
}

type AppliedFilter = NonNullable<Message['appliedFilters']>[number];

function AppliedFiltersChips({ filters }: { filters: AppliedFilter[] }) {
  if (!filters.length) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground">
        <Filter className="h-3 w-3" />
        Filters applied:
      </span>
      {filters.map((f, i) => {
        const verb = f.op === 'not_in' ? '≠' : '=';
        const valueText = f.values.length > 3
          ? `${f.values.slice(0, 3).join(', ')} +${f.values.length - 3}`
          : f.values.join(', ');
        return (
          <span
            key={`${f.column}-${i}`}
            className="inline-flex items-center gap-1 rounded-full border border-border bg-muted px-2 py-0.5 text-xs text-foreground"
            title={`${f.column} ${verb} ${f.values.join(', ')}`}
          >
            <span className="font-medium">{f.column}</span>
            <span className="text-muted-foreground">{verb}</span>
            <span>{valueText}</span>
          </span>
        );
      })}
    </div>
  );
}

function ChartTypeIcon({ type, className }: { type: ChartSpec['type']; className?: string }) {
  switch (type) {
    case 'line':
    case 'area':
      return <TrendingUp className={className} />;
    case 'bar':
      return <BarChart2 className={className} />;
    case 'pie':
      return <PieChart className={className} />;
    case 'scatter':
      return <Crosshair className={className} />;
    case 'heatmap':
      return <LayoutGrid className={className} />;
    default:
      return <BarChart2 className={className} />;
  }
}

// ---- ChartCard -------------------------------------------------------------

interface ChartCardProps {
  chart: ChartSpec;
  idx: number;
  sessionId?: string | null;
  thinkingSteps: ThinkingStep[];
}

function ChartCard({ chart, idx, sessionId, thinkingSteps }: ChartCardProps) {
  const loadingState = extractCorrelationLoadingState(chart, thinkingSteps);

  return (
    <div className="flex flex-col overflow-hidden rounded-brand-lg border border-border bg-card shadow-elev-1">
      {/* Title bar */}
      <div className="flex items-center gap-2 border-b border-border/60 bg-muted/30 px-4 py-2.5">
        <ChartTypeIcon
          type={chart.type}
          className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground"
        />
        <span className="flex-1 truncate text-sm font-medium text-foreground">{chart.title}</span>
      </div>

      {/* Chart body */}
      <div className="flex-1 px-2 py-2">
        <Suspense fallback={<Skeleton className="h-[260px] w-full rounded-brand-md" />}>
          <ChartRenderer
            chart={chart}
            index={idx}
            isSingleChart={false}
            enableFilters
            isLoading={loadingState.isLoading}
            loadingProgress={loadingState.progress}
            keyInsightSessionId={sessionId ?? null}
          />
        </Suspense>
      </div>

      {/* Per-chart insight callout */}
      {chart.keyInsight && (
        <div className="mx-4 mb-3 mt-0 rounded-r-brand-sm border-l-2 border-primary/60 bg-primary/5 px-3 py-2">
          <p className="text-xs leading-relaxed text-muted-foreground">{chart.keyInsight}</p>
        </div>
      )}
    </div>
  );
}

// ---- AnalyticalDashboardResponse -------------------------------------------

export interface AnalyticalDashboardResponseProps {
  message: Message;
  sessionId?: string | null;
  precedingUserQuestion?: string;
  onSuggestedQuestionClick?: (q: string) => void;
  sampleRows?: Record<string, any>[];
  columns?: string[];
  numericColumns?: string[];
  dateColumns?: string[];
  temporalDisplayGrainsByColumn?: Record<string, TemporalDisplayGrain>;
  temporalFacetColumns?: TemporalFacetColumnMeta[];
  thinkingSteps?: ThinkingStep[];
}

export function AnalyticalDashboardResponse({
  message,
  sessionId,
  precedingUserQuestion,
  onSuggestedQuestionClick,
  sampleRows,
  columns,
  numericColumns,
  dateColumns,
  temporalDisplayGrainsByColumn,
  temporalFacetColumns,
  thinkingSteps = [],
}: AnalyticalDashboardResponseProps) {
  const [saving, setSaving] = useState(false);
  const { toast } = useToast();
  const [, setLocation] = useLocation();

  const charts = message.charts ?? [];
  const insights = message.insights ?? [];

  // Pivot tab: only show if pivotDefaults AND there is data to pivot on
  const pivotData = useMemo(() => {
    const preview = (message as any).preview;
    return Array.isArray(preview) && preview.length > 0 ? preview : (sampleRows ?? []);
  }, [(message as any).preview, sampleRows]);

  const hasPivot = !!(message.pivotDefaults && pivotData.length > 0);

  // Follow-up chips: structured field takes priority, then extracted from content
  const { markdownBody, followUpChips } = useMemo(() => {
    const split = splitAssistantFollowUpPrompts(message.content ?? '');
    const structured = (message.followUpPrompts ?? []).map((s) => s.trim()).filter(Boolean);
    const chips = (structured.length > 0 ? structured : split.extractedPrompts).slice(0, 3);
    const body = split.hadYouMightTrySection
      ? split.mainMarkdown
      : (message.content ?? '').trimEnd();
    return { markdownBody: body, followUpChips: chips };
  }, [message.content, message.followUpPrompts]);

  // Dashboard title: agent-emitted name → first chart title → fallback
  const dashboardTitle = useMemo(() => {
    const draft = message.dashboardDraft as { name?: string } | undefined;
    if (draft?.name && typeof draft.name === 'string' && draft.name.trim()) return draft.name.trim();
    if (charts[0]?.title) return charts[0].title;
    return precedingUserQuestion?.slice(0, 80).trim() || 'Analysis';
  }, [message.dashboardDraft, charts, precedingUserQuestion]);

  async function handleSaveAsDashboard() {
    setSaving(true);
    try {
      const strippedCharts = charts.map(stripAgentChartMeta);
      const d = await dashboardsApi.createFromAnalysis({
        name: dashboardTitle,
        question: precedingUserQuestion || '',
        summaryBody: message.content || '',
        limitationsBody: message.unexplained
          ? `${message.unexplained}\n\nObservational session data only. Segment movements show association, not proven causation.`
          : 'Observational session data only. Segment movements show association, not proven causation. Validate material decisions with additional evidence or experiments.',
        recommendationsBody: (message.followUpPrompts ?? [])
          .slice(0, 6)
          .map((p) => `• ${p}`)
          .join('\n'),
        charts: strippedCharts,
      });
      setLocation(`/dashboard?open=${encodeURIComponent(d.id)}`);
      toast({
        title: 'Dashboard created',
        description: `Opening "${d.name}" on the Dashboard page.`,
      });
    } catch (e: any) {
      toast({
        title: 'Could not create dashboard',
        description: e?.message || 'Try again.',
        variant: 'destructive',
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="w-full space-y-4">
      {/* 1. Action bar */}
      <div className="flex items-center justify-between gap-3">
        <h2 className="flex-1 truncate text-sm font-semibold text-foreground">{dashboardTitle}</h2>
        <Button
          size="sm"
          variant="outline"
          className="shrink-0 gap-1.5"
          onClick={handleSaveAsDashboard}
          disabled={saving}
        >
          {saving ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <LayoutDashboard className="h-3.5 w-3.5" />
          )}
          {saving ? 'Saving…' : 'Save as Dashboard'}
        </Button>
      </div>

      {/* 2a. Applied-filters chips — visible scope of this turn's analysis */}
      {message.appliedFilters?.length ? (
        <AppliedFiltersChips filters={message.appliedFilters} />
      ) : null}

      {/* 2. KPI magnitudes strip — renders nothing when empty */}
      <MagnitudesRow items={message.magnitudes as MagnitudeItem[] | undefined} />

      {/* 3. Narrative answer card */}
      {markdownBody.trim().length > 10 && (
        <Settle className="rounded-brand-lg border border-border/60 border-l-4 border-l-primary bg-primary/5 p-5 shadow-elev-1">
          <div className="text-[15px] leading-[24px] text-foreground">
            <MarkdownRenderer content={markdownBody} />
          </div>
          {followUpChips.length > 0 && onSuggestedQuestionClick && (
            <div className="mt-4">
              <p className="mb-2 text-sm font-semibold text-foreground">You might try:</p>
              <div className="flex flex-wrap gap-2">
                {followUpChips.map((q, i) => (
                  <Button
                    key={`chip-${i}`}
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-auto rounded-full px-3 py-1.5 text-xs"
                    onClick={() => onSuggestedQuestionClick(q)}
                  >
                    {q}
                  </Button>
                ))}
              </div>
            </div>
          )}
        </Settle>
      )}

      {/* 4. Charts / Pivot tabs */}
      {charts.length > 0 && (
        <Tabs defaultValue="charts">
          <TabsList className="mb-3">
            <TabsTrigger value="charts" className="gap-1.5 text-xs">
              <BarChart2 className="h-3.5 w-3.5" />
              Charts ({charts.length})
            </TabsTrigger>
            {hasPivot && (
              <TabsTrigger value="pivot" className="gap-1.5 text-xs">
                <Table2 className="h-3.5 w-3.5" />
                Pivot
              </TabsTrigger>
            )}
          </TabsList>

          <TabsContent value="charts" className="mt-0">
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              {charts.map((chart, idx) => (
                <Settle
                  key={idx}
                  delayMs={idx * 55}
                  className={cn(isFullWidthChart(chart) && 'lg:col-span-2')}
                >
                  <ChartCard
                    chart={chart}
                    idx={idx}
                    sessionId={sessionId}
                    thinkingSteps={thinkingSteps}
                  />
                </Settle>
              ))}
            </div>
          </TabsContent>

          {hasPivot && (
            <TabsContent value="pivot" className="mt-0">
              <DataPreviewTable
                data={pivotData}
                sessionId={sessionId}
                variant="analysis"
                columns={columns}
                numericColumns={numericColumns}
                dateColumns={dateColumns}
                temporalDisplayGrainsByColumn={temporalDisplayGrainsByColumn}
                temporalFacetColumns={temporalFacetColumns}
                pivotDefaults={message.pivotDefaults}
                pivotInsight={insights[0]?.text}
              />
            </TabsContent>
          )}
        </Tabs>
      )}

      {/* 5. Key Findings */}
      {insights.length > 0 && <InsightCard insights={insights} />}

      {/* 6. Limitations callout */}
      {message.unexplained && (
        <div className="rounded-brand-md border border-border bg-muted/40 px-4 py-3 text-sm text-muted-foreground">
          <span className="font-medium text-foreground">Note: </span>
          {message.unexplained}
        </div>
      )}
    </div>
  );
}

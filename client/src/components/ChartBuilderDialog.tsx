import { Suspense, useCallback, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { BarChart3, Loader2 } from 'lucide-react';
import { api } from '@/lib/httpClient';
import type { ChartSpec } from '@/shared/schema';
import { ChartRenderer } from '@/pages/Home/Components/ChartRenderer';
import { Skeleton } from '@/components/ui/skeleton';

type ChartKind =
  | 'line'
  | 'bar'
  | 'scatter'
  | 'pie'
  | 'area'
  | 'heatmap';

interface ChartBuilderDialogProps {
  sessionId: string | null | undefined;
  columns: string[];
  numericColumns: string[];
  dateColumns: string[];
  onChartAdded: (chart: ChartSpec) => void;
}

export function ChartBuilderDialog({
  sessionId,
  columns,
  numericColumns,
  dateColumns,
  onChartAdded,
}: ChartBuilderDialogProps) {
  const [open, setOpen] = useState(false);
  const [chartType, setChartType] = useState<ChartKind>('bar');
  const [title, setTitle] = useState('Custom chart');
  const [xCol, setXCol] = useState('');
  const [yCol, setYCol] = useState('');
  const [zCol, setZCol] = useState('');
  const [seriesCol, setSeriesCol] = useState('');
  const [barLayout, setBarLayout] = useState<'stacked' | 'grouped'>('stacked');
  const [preview, setPreview] = useState<ChartSpec | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canBuild = Boolean(sessionId && xCol && yCol && columns.length);

  const runPreview = useCallback(async () => {
    if (!sessionId || !xCol || !yCol) {
      setError('Choose X and Y columns.');
      return;
    }
    if (chartType === 'heatmap' && !zCol) {
      setError('Heatmaps require a value column (Z).');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const body: Record<string, unknown> = {
        title: title.trim() || 'Chart',
        type: chartType,
        x: xCol,
        y: chartType === 'heatmap' ? yCol : yCol,
        aggregate: chartType === 'scatter' ? 'none' : 'sum',
      };
      if (chartType === 'heatmap') {
        body.z = zCol;
        body.y = yCol;
      }
      if (chartType === 'bar' && seriesCol) {
        body.seriesColumn = seriesCol;
        body.barLayout = barLayout;
      }
      const res = await api.post<{ chart: ChartSpec }>(
        `/api/sessions/${sessionId}/chart-preview`,
        { chart: body }
      );
      setPreview(res.chart);
    } catch (e: unknown) {
      setPreview(null);
      setError(e instanceof Error ? e.message : 'Preview failed');
    } finally {
      setLoading(false);
    }
  }, [sessionId, title, chartType, xCol, yCol, zCol, seriesCol, barLayout]);

  const addToChat = () => {
    if (!preview) return;
    onChartAdded(preview);
    setOpen(false);
    setPreview(null);
  };

  const disabled = !columns.length || !sessionId;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          type="button"
          variant="outline"
          className="h-11 px-4 text-sm font-medium border-2 border-border bg-card hover:bg-muted/40 focus:ring-2 focus:ring-primary/40 focus:border-primary shadow-sm rounded-xl gap-2"
          disabled={disabled}
          title={disabled ? 'Upload data to build charts' : 'Build a chart'}
        >
          <BarChart3 className="w-4 h-4 text-muted-foreground" />
          <span>Build chart</span>
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Build chart</DialogTitle>
          <DialogDescription>
            Map columns to axes, preview with server processing, then add the chart to this chat.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label>Chart type</Label>
            <Select
              value={chartType}
              onValueChange={(v) => setChartType(v as ChartKind)}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="bar">Bar (stacked/grouped if series)</SelectItem>
                <SelectItem value="line">Line</SelectItem>
                <SelectItem value="area">Area</SelectItem>
                <SelectItem value="scatter">Scatter</SelectItem>
                <SelectItem value="pie">Pie</SelectItem>
                <SelectItem value="heatmap">Heatmap</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>Title</Label>
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Chart title"
            />
          </div>
          <div className="space-y-2">
            <Label>X axis</Label>
            <Select value={xCol || undefined} onValueChange={setXCol}>
              <SelectTrigger>
                <SelectValue placeholder="Column" />
              </SelectTrigger>
              <SelectContent>
                {columns.map((c) => (
                  <SelectItem key={c} value={c}>
                    {c}
                    {dateColumns.includes(c) ? ' (date)' : ''}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>{chartType === 'heatmap' ? 'Columns (Y)' : 'Y axis'}</Label>
            <Select value={yCol || undefined} onValueChange={setYCol}>
              <SelectTrigger>
                <SelectValue placeholder="Column" />
              </SelectTrigger>
              <SelectContent>
                {columns.map((c) => (
                  <SelectItem key={c} value={c}>
                    {c}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {chartType === 'heatmap' && (
            <div className="space-y-2 sm:col-span-2">
              <Label>Value (Z)</Label>
              <Select value={zCol || undefined} onValueChange={setZCol}>
                <SelectTrigger>
                  <SelectValue placeholder="Numeric column" />
                </SelectTrigger>
                <SelectContent>
                  {numericColumns.map((c) => (
                    <SelectItem key={c} value={c}>
                      {c}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          {chartType === 'bar' && (
            <>
              <div className="space-y-2">
                <Label>Series column (optional)</Label>
                <Select
                  value={seriesCol || 'none'}
                  onValueChange={(v) => setSeriesCol(v === 'none' ? '' : v)}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="None — single series" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">None</SelectItem>
                    {columns
                      .filter((c) => c !== xCol && c !== yCol)
                      .map((c) => (
                        <SelectItem key={c} value={c}>
                          {c}
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
              </div>
              {seriesCol ? (
                <div className="space-y-2">
                  <Label>Bar layout</Label>
                  <Select
                    value={barLayout}
                    onValueChange={(v) => setBarLayout(v as 'stacked' | 'grouped')}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="stacked">Stacked</SelectItem>
                      <SelectItem value="grouped">Grouped</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              ) : null}
            </>
          )}
        </div>

        {error && (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        )}

        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="secondary" onClick={runPreview} disabled={!canBuild || loading}>
            {loading ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
            Update preview
          </Button>
          <Button type="button" onClick={addToChat} disabled={!preview}>
            Add to chat
          </Button>
        </div>

        <div className="rounded-xl border border-border bg-muted/20 p-4 min-h-[400px]">
          {loading && (
            <div className="flex items-center justify-center h-[220px]">
              <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
            </div>
          )}
          {!loading && preview && (
            <Suspense fallback={<Skeleton className="h-[400px] w-full" />}>
              <ChartRenderer
                chart={preview}
                index={0}
                isSingleChart
                showAddButton
                enableFilters
                keyInsightSessionId={sessionId ?? null}
              />
            </Suspense>
          )}
          {!loading && !preview && (
            <p className="text-sm text-muted-foreground text-center py-16">
              Configure axes and click &quot;Update preview&quot;.
            </p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

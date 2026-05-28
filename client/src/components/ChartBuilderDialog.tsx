import { Suspense, useCallback, useMemo, useState } from 'react';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { ArrowLeft, BarChart3, Loader2 } from 'lucide-react';
import { api } from '@/lib/httpClient';
import type {
  ChartSpec,
  ChartSpecV2,
  ChartV2Mark,
  ChartFieldType,
  ChartEncoding,
  ChartEncodingChannel,
  ChartAggOp,
} from '@/shared/schema';
import { isChartSpecV2 } from '@/shared/schema';
import { ChartRenderer } from '@/pages/Home/Components/ChartRenderer';
import { PremiumChart } from '@/components/charts/PremiumChart';
import { ChartShim } from '@/components/charts/ChartShim';
import { Skeleton } from '@/components/ui/skeleton';
import { MarkGallery } from '@/components/charts/MarkGallery';
import { MARKS } from '@/lib/charts/markMeta';
import { buildV2Spec } from '@/lib/charts/specBuilder';

type ChartKind = 'line' | 'bar' | 'scatter' | 'pie' | 'area' | 'heatmap';
const V1_MARKS: Record<string, ChartKind> = {
  bar: 'bar',
  line: 'line',
  area: 'area',
  point: 'scatter',
  arc: 'pie',
  rect: 'heatmap',
};

const AGG_OPTIONS: { value: ChartAggOp; label: string }[] = [
  { value: 'sum', label: 'Sum' },
  { value: 'mean', label: 'Mean' },
  { value: 'count', label: 'Count' },
  { value: 'median', label: 'Median' },
  { value: 'min', label: 'Min' },
  { value: 'max', label: 'Max' },
];

interface ChartBuilderDialogProps {
  sessionId: string | null | undefined;
  columns: string[];
  numericColumns: string[];
  dateColumns: string[];
  sampleRows?: Record<string, unknown>[];
  onChartAdded: (chart: ChartSpec | ChartSpecV2) => void;
}

function inferFieldType(
  col: string,
  numericColumns: string[],
  dateColumns: string[],
): ChartFieldType {
  if (numericColumns.includes(col)) return 'q';
  if (dateColumns.includes(col)) return 't';
  return 'n';
}

interface EncodingFields {
  showX: boolean;
  showY: boolean;
  showY2: boolean;
  showColor: boolean;
  showSize: boolean;
  xLabel: string;
  yLabel: string;
  y2Label: string;
  colorLabel: string;
  sizeLabel: string;
}

function fieldsForMark(mark: ChartV2Mark): EncodingFields {
  const base: EncodingFields = {
    showX: true,
    showY: true,
    showY2: false,
    showColor: false,
    showSize: false,
    xLabel: 'X axis',
    yLabel: 'Y axis',
    y2Label: 'Y2 axis',
    colorLabel: 'Color',
    sizeLabel: 'Size',
  };

  switch (mark) {
    case 'combo':
    case 'candlestick':
      return { ...base, showY2: true, y2Label: mark === 'candlestick' ? 'High/Low (Y2)' : 'Secondary axis (Y2)' };
    case 'rect':
      return { ...base, showColor: true, colorLabel: 'Value (color)', yLabel: 'Columns (Y)' };
    case 'sankey':
      return { ...base, showSize: true, xLabel: 'Source', yLabel: 'Target', sizeLabel: 'Flow size' };
    case 'bubble':
      return { ...base, showSize: true, sizeLabel: 'Bubble size' };
    case 'calendar':
      return { ...base, showColor: true, xLabel: 'Date column', yLabel: 'Value (Y)', colorLabel: 'Color value' };
    case 'choropleth':
      return { ...base, showColor: true, xLabel: 'Region', colorLabel: 'Value (color)' };
    case 'gauge':
    case 'kpi':
      return { ...base, showX: false, yLabel: 'Value' };
    case 'box':
      return { ...base, xLabel: 'Category (optional)' };
    case 'arc':
      return { ...base, xLabel: 'Category', yLabel: 'Value' };
    case 'bar':
      return { ...base, showColor: true, colorLabel: 'Series (optional)' };
    case 'line':
    case 'area':
      return { ...base, showColor: true, colorLabel: 'Series (optional)' };
    default:
      return base;
  }
}

export function ChartBuilderDialog({
  sessionId,
  columns,
  numericColumns,
  dateColumns,
  sampleRows,
  onChartAdded,
}: ChartBuilderDialogProps) {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<'pick' | 'configure'>('pick');
  const [selectedMark, setSelectedMark] = useState<ChartV2Mark | null>(null);

  // Encoding state
  const [xCol, setXCol] = useState('');
  const [yCol, setYCol] = useState('');
  const [y2Col, setY2Col] = useState('');
  const [colorCol, setColorCol] = useState('');
  const [sizeCol, setSizeCol] = useState('');
  const [aggOp, setAggOp] = useState<ChartAggOp>('sum');
  const [title, setTitle] = useState('Custom chart');

  // v1 preview (fallback when no sampleRows)
  const [v1Preview, setV1Preview] = useState<ChartSpec | null>(null);
  const [v1Loading, setV1Loading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const disabled = !columns.length || !sessionId;
  const fields = selectedMark ? fieldsForMark(selectedMark) : null;

  const resetConfig = useCallback(() => {
    setXCol('');
    setYCol('');
    setY2Col('');
    setColorCol('');
    setSizeCol('');
    setAggOp('sum');
    setTitle('Custom chart');
    setV1Preview(null);
    setError(null);
  }, []);

  const handleMarkSelect = useCallback(
    (mark: ChartV2Mark) => {
      setSelectedMark(mark);
      resetConfig();
      setStep('configure');
    },
    [resetConfig],
  );

  const handleBack = useCallback(() => {
    setStep('pick');
    setSelectedMark(null);
    resetConfig();
  }, [resetConfig]);

  const handleOpenChange = useCallback(
    (next: boolean) => {
      setOpen(next);
      if (!next) {
        setStep('pick');
        setSelectedMark(null);
        resetConfig();
      }
    },
    [resetConfig],
  );

  const markMeta = useMemo(
    () => (selectedMark ? MARKS.find((m) => m.mark === selectedMark) : null),
    [selectedMark],
  );

  // Build v2 spec client-side
  const v2Spec = useMemo(() => {
    if (!selectedMark || !sampleRows?.length) return null;
    if (!fields) return null;
    if (fields.showX && !xCol) return null;
    if (fields.showY && !yCol) return null;

    const enc: ChartEncoding = {};
    if (xCol) {
      enc.x = {
        field: xCol,
        type: inferFieldType(xCol, numericColumns, dateColumns),
      };
    }
    if (yCol) {
      const yType = inferFieldType(yCol, numericColumns, dateColumns);
      enc.y = {
        field: yCol,
        type: yType,
        aggregate: yType === 'q' ? aggOp : undefined,
      } as ChartEncodingChannel;
    }
    if (y2Col && fields.showY2) {
      enc.y2 = {
        field: y2Col,
        type: inferFieldType(y2Col, numericColumns, dateColumns),
      };
    }
    if (colorCol && fields.showColor) {
      enc.color = {
        field: colorCol,
        type: inferFieldType(colorCol, numericColumns, dateColumns),
      };
    }
    if (sizeCol && fields.showSize) {
      enc.size = {
        field: sizeCol,
        type: inferFieldType(sizeCol, numericColumns, dateColumns),
      };
    }

    try {
      return buildV2Spec({
        mark: selectedMark,
        encoding: enc,
        rows: sampleRows,
        title: title.trim() || undefined,
      });
    } catch {
      return null;
    }
  }, [selectedMark, sampleRows, fields, xCol, yCol, y2Col, colorCol, sizeCol, aggOp, title, numericColumns, dateColumns]);

  // Fallback: v1 server-side preview for legacy types when no sampleRows
  const isV1Fallback = selectedMark && selectedMark in V1_MARKS && !sampleRows?.length;

  const runV1Preview = useCallback(async () => {
    if (!sessionId || !xCol || !yCol || !selectedMark) return;
    const v1Type = V1_MARKS[selectedMark];
    if (!v1Type) return;
    setV1Loading(true);
    setError(null);
    try {
      const body: Record<string, unknown> = {
        title: title.trim() || 'Chart',
        type: v1Type,
        x: xCol,
        y: yCol,
        aggregate: v1Type === 'scatter' ? 'none' : aggOp,
      };
      if (v1Type === 'heatmap' && colorCol) {
        body.z = colorCol;
      }
      const res = await api.post<{ chart: ChartSpec }>(
        `/api/sessions/${sessionId}/chart-preview`,
        { chart: body },
      );
      setV1Preview(res.chart);
    } catch (e: unknown) {
      setV1Preview(null);
      setError(e instanceof Error ? e.message : 'Preview failed');
    } finally {
      setV1Loading(false);
    }
  }, [sessionId, selectedMark, xCol, yCol, colorCol, title, aggOp]);

  const handleAddToChat = useCallback(() => {
    if (v2Spec) {
      onChartAdded(v2Spec);
    } else if (v1Preview) {
      onChartAdded(v1Preview);
    }
    handleOpenChange(false);
  }, [v2Spec, v1Preview, onChartAdded, handleOpenChange]);

  const canAdd = !!(v2Spec || v1Preview);
  const hasRequiredFields = fields
    ? (!fields.showX || !!xCol) && (!fields.showY || !!yCol)
    : false;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
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
        {step === 'pick' ? (
          <>
            <DialogHeader>
              <DialogTitle>Select a chart type</DialogTitle>
              <DialogDescription>
                Choose from {MARKS.length} chart types. Click one to configure
                its axes.
              </DialogDescription>
            </DialogHeader>
            <MarkGallery value={selectedMark} onChange={handleMarkSelect} />
          </>
        ) : (
          <>
            <DialogHeader>
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8"
                  onClick={handleBack}
                >
                  <ArrowLeft className="h-4 w-4" />
                </Button>
                <div>
                  <DialogTitle className="flex items-center gap-2">
                    {markMeta && (
                      <markMeta.icon className="h-5 w-5 text-primary" />
                    )}
                    {markMeta?.label ?? 'Chart'}
                  </DialogTitle>
                  <DialogDescription>
                    Map columns to encodings, then add to chat.
                  </DialogDescription>
                </div>
              </div>
            </DialogHeader>

            {fields && (
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label>Title</Label>
                  <Input
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    placeholder="Chart title"
                  />
                </div>

                {fields.showX && (
                  <div className="space-y-2">
                    <Label>{fields.xLabel}</Label>
                    <Select
                      value={xCol || undefined}
                      onValueChange={setXCol}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Column" />
                      </SelectTrigger>
                      <SelectContent>
                        {columns.map((c) => (
                          <SelectItem key={c} value={c}>
                            {c}
                            {dateColumns.includes(c)
                              ? ' (date)'
                              : numericColumns.includes(c)
                                ? ' (numeric)'
                                : ''}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}

                {fields.showY && (
                  <div className="space-y-2">
                    <Label>{fields.yLabel}</Label>
                    <Select
                      value={yCol || undefined}
                      onValueChange={setYCol}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Column" />
                      </SelectTrigger>
                      <SelectContent>
                        {columns.map((c) => (
                          <SelectItem key={c} value={c}>
                            {c}
                            {numericColumns.includes(c)
                              ? ' (numeric)'
                              : ''}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}

                {fields.showY && yCol && numericColumns.includes(yCol) && (
                  <div className="space-y-2">
                    <Label>Aggregation</Label>
                    <Select
                      value={aggOp}
                      onValueChange={(v) => setAggOp(v as ChartAggOp)}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {AGG_OPTIONS.map((o) => (
                          <SelectItem key={o.value} value={o.value}>
                            {o.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}

                {fields.showY2 && (
                  <div className="space-y-2">
                    <Label>{fields.y2Label}</Label>
                    <Select
                      value={y2Col || undefined}
                      onValueChange={setY2Col}
                    >
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
                )}

                {fields.showColor && (
                  <div className="space-y-2">
                    <Label>{fields.colorLabel}</Label>
                    <Select
                      value={colorCol || 'none'}
                      onValueChange={(v) =>
                        setColorCol(v === 'none' ? '' : v)
                      }
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="None" />
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
                )}

                {fields.showSize && (
                  <div className="space-y-2">
                    <Label>{fields.sizeLabel}</Label>
                    <Select
                      value={sizeCol || undefined}
                      onValueChange={setSizeCol}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Column" />
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
              </div>
            )}

            {error && (
              <p className="text-sm text-destructive" role="alert">
                {error}
              </p>
            )}

            <div className="flex flex-wrap gap-2">
              {isV1Fallback && (
                <Button
                  type="button"
                  variant="secondary"
                  onClick={runV1Preview}
                  disabled={!hasRequiredFields || v1Loading}
                >
                  {v1Loading ? (
                    <Loader2 className="w-4 h-4 animate-spin mr-2" />
                  ) : null}
                  Update preview
                </Button>
              )}
              <Button
                type="button"
                onClick={handleAddToChat}
                disabled={!canAdd}
              >
                Add to chat
              </Button>
            </div>

            <div className="rounded-xl border border-border bg-muted/20 p-4 min-h-[350px]">
              {v1Loading && (
                <div className="flex items-center justify-center h-[220px]">
                  <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
                </div>
              )}
              {!v1Loading && v2Spec && (
                <Suspense
                  fallback={<Skeleton className="h-[350px] w-full" />}
                >
                  <PremiumChart
                    spec={v2Spec}
                    data={
                      v2Spec.source.kind === 'inline'
                        ? (v2Spec.source.rows as Record<string, unknown>[])
                        : []
                    }
                    height={350}
                  />
                </Suspense>
              )}
              {!v1Loading && !v2Spec && v1Preview && (
                <Suspense
                  fallback={<Skeleton className="h-[350px] w-full" />}
                >
                  <ChartRenderer
                    chart={v1Preview}
                    index={0}
                    isSingleChart
                    showAddButton={false}
                    enableFilters={false}
                    keyInsightSessionId={sessionId ?? null}
                  />
                </Suspense>
              )}
              {!v1Loading && !v2Spec && !v1Preview && (
                <p className="text-sm text-muted-foreground text-center py-16">
                  {hasRequiredFields
                    ? isV1Fallback
                      ? 'Click "Update preview" to see your chart.'
                      : 'Preview will appear once data is available.'
                    : 'Select columns above to see a live preview.'}
                </p>
              )}
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

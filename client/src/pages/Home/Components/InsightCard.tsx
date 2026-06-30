import { useState } from 'react';
import { DashboardTableSpec, Insight } from '@/shared/schema';
import { Card } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { Lightbulb, ChevronDown, ChevronUp } from 'lucide-react';
import { Plus } from 'lucide-react';
import { DashboardTableModal } from './DashboardModal/DashboardTableModal';
import { renderInsightText, splitInsightHeadlineDetail, normalizeInsightText } from '@/lib/insightText';

interface InsightCardProps {
  insights: Insight[];
}

const TABLE_V1_PREFIX = 'TABLE_V1|';

type TableV1Payload = {
  caption?: string;
  columns?: string[];
  rows?: Array<Array<string | number>>;
};

const tryParseTableV1 = (text: string): TableV1Payload | null => {
  if (!text || typeof text !== 'string' || !text.startsWith(TABLE_V1_PREFIX)) return null;
  const payload = text.slice(TABLE_V1_PREFIX.length);
  try {
    const parsed = JSON.parse(payload) as TableV1Payload;
    if (!parsed || !Array.isArray(parsed.columns) || !Array.isArray(parsed.rows)) return null;
    return parsed;
  } catch {
    return null;
  }
};

export function InsightCard({ insights }: InsightCardProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [isDashboardTableModalOpen, setIsDashboardTableModalOpen] = useState(false);
  const [pendingTableSpec, setPendingTableSpec] = useState<DashboardTableSpec | null>(null);
  
  if (!insights || insights.length === 0) return null;

  // W-INS-DEDUP · Safety net for already-persisted analyses: a turn could have
  // stacked the same insight set twice (server merge had no dedup). Drop exact
  // (normalized-text) duplicates here so a reloaded "7 then the same 7" collapses
  // to 7, and renumber for display.
  const seenText = new Set<string>();
  const dedupedInsights = insights
    .filter((i) => {
      const key = normalizeInsightText(i.text);
      if (!key || seenText.has(key)) return false;
      seenText.add(key);
      return true;
    })
    .map((i, idx) => ({ ...i, id: idx + 1 }));

  const INITIAL_DISPLAY_COUNT = 3;
  const hasMoreInsights = dedupedInsights.length > INITIAL_DISPLAY_COUNT;
  const displayedInsights = isExpanded ? dedupedInsights : dedupedInsights.slice(0, INITIAL_DISPLAY_COUNT);
  const hiddenCount = dedupedInsights.length - INITIAL_DISPLAY_COUNT;

  return (
    <>
      <Card className="bg-primary/5 border-l-4 border-l-primary shadow-sm" data-testid="insight-card">
      <div className="p-6">
        <div className="flex items-center gap-2 mb-4">
          <Lightbulb className="w-5 h-5 text-primary" />
          <h3 className="text-lg font-semibold text-foreground">Key Insights</h3>
          {hasMoreInsights && (
            <span className="text-xs text-muted-foreground ml-auto">
              {dedupedInsights.length} insights
            </span>
          )}
        </div>
        <ul className="space-y-4">
          {displayedInsights.map((insight) => {
            const tablePayload = tryParseTableV1(insight.text);
            if (tablePayload) {
              return (
                <li key={insight.id} className="space-y-2" data-testid={`insight-${insight.id}`}>
                  <div className="flex gap-3">
                    <span className="flex-shrink-0 w-6 h-6 rounded-full bg-primary text-primary-foreground text-sm font-medium flex items-center justify-center mt-0.5">
                      {insight.id}
                    </span>
                    <div className="flex-1 space-y-2">
                      {tablePayload.caption && (
                        <div className="text-sm font-medium text-foreground leading-relaxed">
                          {tablePayload.caption}
                        </div>
                      )}
                      <div className="max-h-[220px] overflow-y-auto rounded-md border bg-background/50">
                        <Table>
                          <TableHeader>
                            <TableRow>
                              {tablePayload.columns!.map((col, idx) => (
                                <TableHead key={idx} className="text-xs font-semibold text-muted-foreground">
                                  {col}
                                </TableHead>
                              ))}
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {tablePayload.rows!.map((row, rIdx) => (
                              <TableRow key={rIdx}>
                                {tablePayload.columns!.map((_, cIdx) => (
                                  <TableCell key={cIdx} className="text-sm text-foreground">
                                    {row?.[cIdx] ?? ''}
                                  </TableCell>
                                ))}
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      </div>

                      <div className="pt-2">
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-8 gap-1"
                          onClick={(e) => {
                            e.stopPropagation();
                            const spec: DashboardTableSpec = {
                              caption: (tablePayload.caption || 'Table').trim(),
                              columns: (tablePayload.columns || []).map((c) => String(c)),
                              rows: (tablePayload.rows || []).map((row) =>
                                row.map((cell) => (cell === undefined ? null : cell))
                              ) as any,
                            };
                            setPendingTableSpec(spec);
                            setIsDashboardTableModalOpen(true);
                          }}
                        >
                          <Plus className="h-3.5 w-3.5" />
                          Add to Dashboard
                        </Button>
                      </div>
                    </div>
                  </div>
                </li>
              );
            }

            const { headline, detail } = splitInsightHeadlineDetail(insight.text);
            return (
              <li key={insight.id} className="space-y-2" data-testid={`insight-${insight.id}`}>
                <div className="flex gap-3">
                  <span className="flex-shrink-0 w-6 h-6 rounded-full bg-primary text-primary-foreground text-sm font-medium flex items-center justify-center mt-0.5">
                    {insight.id}
                  </span>
                  <div className="flex-1 space-y-1">
                    <div className="text-sm text-foreground leading-relaxed">
                      {renderInsightText(headline)}
                    </div>
                    {detail && (
                      <div className="text-sm text-muted-foreground leading-relaxed">
                        — {renderInsightText(detail)}
                      </div>
                    )}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
        {hasMoreInsights && (
          <button
            onClick={() => setIsExpanded(!isExpanded)}
            className="mt-4 w-full flex items-center justify-center gap-2 text-sm text-primary hover:text-primary/80 transition-colors py-2 border-t border-primary/10"
          >
            {isExpanded ? (
              <>
                <ChevronUp className="w-4 h-4" />
                Show less
              </>
            ) : (
              <>
                <ChevronDown className="w-4 h-4" />
                Show {hiddenCount} more insight{hiddenCount > 1 ? 's' : ''}
              </>
            )}
          </button>
        )}
      </div>
      </Card>
      {pendingTableSpec && (
        <DashboardTableModal
          isOpen={isDashboardTableModalOpen}
          onClose={() => {
            setIsDashboardTableModalOpen(false);
            setPendingTableSpec(null);
          }}
          table={pendingTableSpec}
        />
      )}
    </>
  );
}

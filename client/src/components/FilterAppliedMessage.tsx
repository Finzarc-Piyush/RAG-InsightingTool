import { Card } from '@/components/ui/card';
import { Filter, CheckCircle2 } from 'lucide-react';
import { FilterCondition } from './ColumnFilterDialog';

interface FilterAppliedMessageProps {
  condition: FilterCondition;
  rowsBefore?: number;
  rowsAfter?: number;
}

export function FilterAppliedMessage({ 
  condition, 
  rowsBefore, 
  rowsAfter 
}: FilterAppliedMessageProps) {
  const formatCondition = (cond: FilterCondition): string => {
    if (cond.operator === 'between') {
      return `${cond.column} is between ${cond.value} and ${cond.value2}`;
    } else if (cond.operator === 'in') {
      const valuesStr = cond.values?.map(v => `"${v}"`).join(', ') || '';
      return `${cond.column} is in [${valuesStr}]`;
    } else if (cond.operator === 'contains') {
      return `${cond.column} contains "${cond.value}"`;
    } else if (cond.operator === 'startsWith') {
      return `${cond.column} starts with "${cond.value}"`;
    } else if (cond.operator === 'endsWith') {
      return `${cond.column} ends with "${cond.value}"`;
    } else {
      return `${cond.column} ${cond.operator} ${cond.value}`;
    }
  };

  const rowsRemoved = rowsBefore && rowsAfter ? rowsBefore - rowsAfter : undefined;

  return (
    <Card className="p-4 mb-4 border-l-4 border-l-primary bg-[hsl(var(--primary)/0.05)]">
      <div className="flex items-start gap-3">
        <div className="flex-shrink-0 w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center">
          <Filter className="w-5 h-5 text-primary" />
        </div>
        <div className="flex-1">
          <div className="flex items-center gap-2 mb-2">
            <CheckCircle2 className="w-5 h-5 text-green-600 dark:text-green-400" />
            <h4 className="font-semibold text-foreground">Data Filter Applied</h4>
          </div>
          <p className="text-sm text-muted-foreground mb-3">
            Your dataset has been filtered based on the following condition:
          </p>
          <div className="bg-card border border-border rounded-lg p-3 mb-3">
            <p className="text-sm font-mono text-foreground">
              {formatCondition(condition)}
            </p>
          </div>
          {rowsBefore !== undefined && rowsAfter !== undefined && (
            <div className="flex items-center gap-4 text-sm">
              <div className="flex items-center gap-2">
                <span className="text-muted-foreground">Rows before:</span>
                <span className="font-semibold text-foreground tabular-nums">
                  {rowsBefore.toLocaleString()}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-muted-foreground">Rows after:</span>
                <span className="font-semibold text-green-600 dark:text-green-400 tabular-nums">
                  {rowsAfter.toLocaleString()}
                </span>
              </div>
              {rowsRemoved !== undefined && (
                <div className="flex items-center gap-2">
                  <span className="text-muted-foreground">Rows removed:</span>
                  <span className="font-semibold text-red-600 dark:text-red-400 tabular-nums">
                    {rowsRemoved.toLocaleString()}
                  </span>
                </div>
              )}
            </div>
          )}
          <p className="text-xs text-muted-foreground mt-3 italic">
            The filtered dataset is now your working dataset. All subsequent queries will work on this filtered data.
          </p>
        </div>
      </div>
    </Card>
  );
}

import React from 'react';

type LegendEntry = {
  value?: string;
  color?: string;
  type?: string;
};

function LegendSwatch({
  color,
  entryType,
  iconType,
  hidden,
}: {
  color: string;
  entryType?: string;
  iconType?: string;
  hidden?: boolean;
}) {
  const style = { backgroundColor: hidden ? 'hsl(var(--muted-foreground))' : color };
  if (iconType === 'circle' || entryType === 'circle') {
    return (
      <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={style} />
    );
  }
  if (entryType === 'rect') {
    return (
      <span className="h-3 w-3 shrink-0 rounded-sm" style={style} />
    );
  }
  return <span className="h-0.5 w-7 shrink-0 rounded-full" style={style} />;
}

/**
 * Centered legend row with comfortable horizontal spacing, aligned with chart content width.
 * When onToggleSeries / onToggleAll are provided, legend entries become interactive.
 */
export function RechartsWideLegendContent(props: {
  payload?: readonly LegendEntry[];
  iconType?: string;
  hiddenSeries?: Set<string>;
  onToggleSeries?: (key: string) => void;
  onToggleAll?: (showAll: boolean) => void;
}) {
  const { payload, iconType, hiddenSeries, onToggleSeries, onToggleAll } = props;
  if (!payload?.length) return null;

  const isInteractive = !!onToggleSeries;

  return (
    <div
      className="flex w-full flex-wrap items-center justify-center gap-x-6 gap-y-2 px-2 pt-1"
    >
      {isInteractive && onToggleAll && (
        <span className="inline-flex items-center gap-1 mr-2 shrink-0">
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onToggleAll(true); }}
            className="text-[11px] font-medium text-muted-foreground hover:text-foreground px-1.5 py-0.5 rounded border border-border/50 hover:border-border transition-colors"
          >
            All
          </button>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onToggleAll(false); }}
            className="text-[11px] font-medium text-muted-foreground hover:text-foreground px-1.5 py-0.5 rounded border border-border/50 hover:border-border transition-colors"
          >
            None
          </button>
        </span>
      )}
      {payload.map((entry, index) => {
        const key = entry.value ?? '';
        const color = entry.color ?? 'hsl(var(--muted-foreground))';
        const hidden = isInteractive && hiddenSeries?.has(key);

        return (
          <span
            key={`legend-${index}`}
            className={[
              'inline-flex items-center gap-2 text-[13px] font-semibold select-none',
              isInteractive ? 'cursor-pointer' : '',
              hidden ? 'opacity-40' : 'text-foreground',
            ].join(' ')}
            onClick={isInteractive ? (e) => { e.stopPropagation(); onToggleSeries!(key); } : undefined}
            title={isInteractive ? (hidden ? `Show ${key}` : `Hide ${key}`) : undefined}
          >
            <LegendSwatch color={color} entryType={entry.type} iconType={iconType} hidden={hidden} />
            <span className={hidden ? 'line-through' : ''}>{key}</span>
          </span>
        );
      })}
    </div>
  );
}

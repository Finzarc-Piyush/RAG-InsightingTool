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
}: {
  color: string;
  entryType?: string;
  iconType?: string;
}) {
  if (iconType === 'circle' || entryType === 'circle') {
    return (
      <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: color }} />
    );
  }
  if (entryType === 'rect') {
    return (
      <span className="h-3 w-3 shrink-0 rounded-sm" style={{ backgroundColor: color }} />
    );
  }
  return <span className="h-0.5 w-7 shrink-0 rounded-full" style={{ backgroundColor: color }} />;
}

/**
 * Centered legend row with comfortable horizontal spacing, aligned with chart content width.
 */
export function RechartsWideLegendContent(props: {
  payload?: readonly LegendEntry[];
  iconType?: string;
}) {
  const { payload, iconType } = props;
  if (!payload?.length) return null;

  return (
    <div className="flex w-full flex-wrap items-center justify-center gap-x-8 gap-y-2 px-2 pt-1">
      {payload.map((entry, index) => {
        const color = entry.color ?? 'hsl(var(--muted-foreground))';
        const label = entry.value ?? '';
        return (
          <span
            key={`legend-${index}`}
            className="inline-flex items-center gap-2 text-[13px] font-semibold text-foreground"
          >
            <LegendSwatch color={color} entryType={entry.type} iconType={iconType} />
            <span>{label}</span>
          </span>
        );
      })}
    </div>
  );
}

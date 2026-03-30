import { useMemo, useState, type ReactNode } from 'react';
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCorners,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Filter, GripVertical, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ScrollArea } from '@/components/ui/scroll-area';
import type {
  FilterSelections,
  PivotAgg,
  PivotUiConfig,
  PivotValueSpec,
} from '@/lib/pivot/types';
import { facetColumnHeaderLabelForColumn } from '@/lib/temporalFacetDisplay';
import type { TemporalFacetColumnMeta } from '@/shared/schema';

const DIM_PREFIX = 'd|';
const VAL_PREFIX = 'v|';

export function dimDndId(field: string): string {
  return `${DIM_PREFIX}${encodeURIComponent(field)}`;
}
function parseDimDndId(id: string): string | null {
  if (!id.startsWith(DIM_PREFIX)) return null;
  return decodeURIComponent(id.slice(DIM_PREFIX.length));
}
export function valDndId(spec: PivotValueSpec): string {
  return `${VAL_PREFIX}${spec.id}`;
}
function parseValDndId(id: string): string | null {
  if (!id.startsWith(VAL_PREFIX)) return null;
  return id.slice(VAL_PREFIX.length);
}

type DimZone = 'filters' | 'columns' | 'rows' | 'unused';
type Zone = DimZone | 'values';

const ZONE_LABEL: Record<Zone, string> = {
  filters: 'Filters',
  columns: 'Columns',
  rows: 'Rows',
  values: 'Values',
  unused: 'Choose fields to add',
};

function zoneDroppableId(z: Zone): string {
  return `z:${z}`;
}

function stripDimension(config: PivotUiConfig, field: string): PivotUiConfig {
  return {
    ...config,
    filters: config.filters.filter((f) => f !== field),
    columns: config.columns.filter((f) => f !== field),
    rows: config.rows.filter((f) => f !== field),
    unused: config.unused.filter((f) => f !== field),
  };
}

function stripValue(config: PivotUiConfig, specId: string): PivotUiConfig {
  return {
    ...config,
    values: config.values.filter((v) => v.id !== specId),
  };
}

function newValueSpec(field: string, numericFields: Set<string>): PivotValueSpec {
  return {
    id: `meas_${field}_${Math.random().toString(36).slice(2, 9)}`,
    field,
    agg: numericFields.has(field) ? 'sum' : 'count',
  };
}

type PivotFieldPanelProps = {
  config: PivotUiConfig;
  onConfigChange: (next: PivotUiConfig) => void;
  filterSelections: FilterSelections;
  onFilterSelectionsChange: (next: FilterSelections) => void;
  data: Record<string, unknown>[];
  numericColumns: string[];
  temporalFacetColumns?: TemporalFacetColumnMeta[];
  className?: string;
};

export function PivotFieldPanel({
  config,
  onConfigChange,
  filterSelections,
  onFilterSelectionsChange,
  data,
  numericColumns,
  temporalFacetColumns = [],
  className,
}: PivotFieldPanelProps) {
  const [activeId, setActiveId] = useState<string | null>(null);
  const numericSet = useMemo(() => new Set(numericColumns), [numericColumns]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor)
  );

  const onDragStart = (e: DragStartEvent) => {
    setActiveId(String(e.active.id));
  };

  const onDragCancel = () => {
    setActiveId(null);
  };

  const onDragEnd = (e: DragEndEvent) => {
    setActiveId(null);
    const { active, over } = e;
    if (!over) return;

    const a = String(active.id);
    const o = String(over.id);

    if (a === o) {
      return;
    }

    const activeDim = parseDimDndId(a);
    const activeValId = parseValDndId(a);

    const activeSort = active.data.current?.sortable as
      | { containerId: string; index: number }
      | undefined;
    const overSort = over.data.current?.sortable as
      | { containerId: string; index: number }
      | undefined;

    const overZoneFromDroppable = o.startsWith('z:') ? (o.slice(2) as Zone) : null;

    if (activeSort && overSort && activeSort.containerId === overSort.containerId) {
      const z = activeSort.containerId as Zone;
      if (z === 'values') {
        onConfigChange({
          ...config,
          values: arrayMove(config.values, activeSort.index, overSort.index),
        });
        return;
      }
      if (z === 'filters' || z === 'columns' || z === 'rows' || z === 'unused') {
        const arr = [...config[z]];
        onConfigChange({
          ...config,
          [z]: arrayMove(arr, activeSort.index, overSort.index),
        });
        return;
      }
    }

    let destZone: Zone | null = overZoneFromDroppable;
    let destIndex: number | null = null;

    if (!destZone && overSort) {
      destZone = overSort.containerId as Zone;
      destIndex = overSort.index;
    }
    if (!destZone) return;

    if (destIndex === null) {
      if (destZone === 'values') destIndex = config.values.length;
      else destIndex = config[destZone as DimZone].length;
    }

    if (activeDim) {
      let next = stripDimension(config, activeDim);
      if (destZone === 'values') {
        const spec = newValueSpec(activeDim, numericSet);
        const vals = [...next.values];
        vals.splice(destIndex, 0, spec);
        onConfigChange({ ...next, values: vals });
        return;
      }
      const key = destZone as DimZone;
      const arr = [...next[key]];
      const filtered = arr.filter((f) => f !== activeDim);
      const insertAt = Math.min(destIndex, filtered.length);
      filtered.splice(insertAt, 0, activeDim);
      onConfigChange({ ...next, [key]: filtered });
      return;
    }

    if (activeValId) {
      const spec = config.values.find((v) => v.id === activeValId);
      if (!spec) return;
      let next = stripValue(config, activeValId);
      next = stripDimension(next, spec.field);
      if (destZone === 'values') {
        const vals = [...next.values];
        vals.splice(destIndex, 0, spec);
        onConfigChange({ ...next, values: vals });
        return;
      }
      const key = destZone as DimZone;
      const arr = [...next[key]];
      arr.splice(destIndex, 0, spec.field);
      onConfigChange({ ...next, [key]: arr });
    }
  };

  const setAgg = (specId: string, agg: PivotAgg) => {
    onConfigChange({
      ...config,
      values: config.values.map((v) => (v.id === specId ? { ...v, agg } : v)),
    });
  };

  const removeDim = (field: string, zone: DimZone) => {
    const arr = config[zone].filter((f) => f !== field);
    onConfigChange({ ...config, [zone]: arr, unused: [...config.unused, field] });
  };

  const removeVal = (specId: string) => {
    const spec = config.values.find((v) => v.id === specId);
    if (!spec) return;
    onConfigChange({
      ...config,
      values: config.values.filter((v) => v.id !== specId),
      unused: [...config.unused, spec.field],
    });
  };

  const fieldTitle = (f: string) =>
    facetColumnHeaderLabelForColumn(f, temporalFacetColumns);

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCorners}
      onDragStart={onDragStart}
      onDragCancel={onDragCancel}
      onDragEnd={onDragEnd}
    >
      <div className={cn('flex flex-col gap-3', className)}>
        <div className="space-y-1">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Pivot fields
          </h3>
          <p className="text-[11px] text-muted-foreground leading-snug">
            Drag fields between areas. Reorder within Rows to change hierarchy.
          </p>
        </div>

        <div className="space-y-2">
          {/* Quick add removed; use checkbox controls in the "unused" chooser below instead. */}
        </div>

        <ScrollArea className="h-[min(62vh,520px)] pr-2">
          <div className="flex flex-col gap-3 pb-2">
            <Well dropId={zoneDroppableId('unused')} title={ZONE_LABEL.unused}>
              <SortableContext
                id="unused"
                items={config.unused.map(dimDndId)}
                strategy={verticalListSortingStrategy}
              >
                {config.unused.map((field) => {
                  const isNumeric = numericSet.has(field);
                  return (
                    <DimCheckboxItem
                      key={field}
                      field={field}
                      label={fieldTitle(field)}
                      numeric={isNumeric}
                      onAdd={() => {
                        const next = stripDimension(config, field);
                        if (isNumeric) {
                          const spec = newValueSpec(field, numericSet);
                          onConfigChange({ ...next, values: [...next.values, spec] });
                        } else {
                          onConfigChange({ ...next, rows: [...next.rows, field] });
                        }
                      }}
                    />
                  );
                })}
              </SortableContext>
            </Well>

            <Well dropId={zoneDroppableId('filters')} title={ZONE_LABEL.filters}>
              <SortableContext
                id="filters"
                items={config.filters.map(dimDndId)}
                strategy={verticalListSortingStrategy}
              >
                {config.filters.map((field) => (
                  <FilterFieldRow
                    key={field}
                    field={field}
                    label={fieldTitle(field)}
                    data={data}
                    selected={filterSelections[field]}
                    onSelectionChange={(next) =>
                      onFilterSelectionsChange({ ...filterSelections, [field]: next })
                    }
                    onRemove={() => removeDim(field, 'filters')}
                  />
                ))}
              </SortableContext>
            </Well>

            <Well dropId={zoneDroppableId('columns')} title={ZONE_LABEL.columns}>
              <SortableContext
                id="columns"
                items={config.columns.map(dimDndId)}
                strategy={verticalListSortingStrategy}
              >
                {config.columns.map((field) => (
                  <DimItem
                    key={field}
                    field={field}
                    label={fieldTitle(field)}
                    trailing={
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 shrink-0 text-muted-foreground"
                        onClick={() => removeDim(field, 'columns')}
                        aria-label={`Remove ${field}`}
                      >
                        <X className="h-3.5 w-3.5" />
                      </Button>
                    }
                  />
                ))}
              </SortableContext>
            </Well>

            <Well dropId={zoneDroppableId('rows')} title={ZONE_LABEL.rows}>
              <SortableContext
                id="rows"
                items={config.rows.map(dimDndId)}
                strategy={verticalListSortingStrategy}
              >
                {config.rows.map((field) => (
                  <DimItem
                    key={field}
                    field={field}
                    label={fieldTitle(field)}
                    trailing={
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 shrink-0 text-muted-foreground"
                        onClick={() => removeDim(field, 'rows')}
                        aria-label={`Remove ${field}`}
                      >
                        <X className="h-3.5 w-3.5" />
                      </Button>
                    }
                  />
                ))}
              </SortableContext>
            </Well>

            <Well dropId={zoneDroppableId('values')} title={ZONE_LABEL.values}>
              <SortableContext
                id="values"
                items={config.values.map((v) => valDndId(v))}
                strategy={verticalListSortingStrategy}
              >
                {config.values.map((spec) => (
                  <ValItem
                    key={spec.id}
                    spec={spec}
                    label={fieldTitle(spec.field)}
                    onAggChange={(agg) => setAgg(spec.id, agg)}
                    onRemove={() => removeVal(spec.id)}
                  />
                ))}
              </SortableContext>
            </Well>
          </div>
        </ScrollArea>
      </div>

      <DragOverlay dropAnimation={null}>
        {activeId && parseDimDndId(activeId) ? (
          <div className="rounded-md border border-primary/30 bg-background px-3 py-2 text-sm shadow-lg">
            {fieldTitle(parseDimDndId(activeId)!)}
          </div>
        ) : activeId && parseValDndId(activeId) ? (
          <div className="rounded-md border border-primary/30 bg-background px-3 py-2 text-sm shadow-lg">
            {fieldTitle(
              config.values.find((v) => v.id === parseValDndId(activeId)!)?.field ?? ''
            )}
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}

function Well({
  title,
  dropId,
  children,
}: {
  title: string;
  dropId: string;
  children: React.ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: dropId });
  return (
    <div
      ref={setNodeRef}
      className={cn(
        'rounded-xl border border-border/80 bg-muted/20 p-2.5 transition-all duration-200',
        isOver && 'ring-2 ring-primary/35 bg-primary/[0.04] border-primary/25'
      )}
    >
      <div className="mb-2">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          {title}
        </span>
      </div>
      <div className="min-h-[40px] space-y-1.5">{children}</div>
    </div>
  );
}

function DimItem({
  field,
  label,
  trailing,
}: {
  field: string;
  label: string;
  trailing?: ReactNode;
}) {
  const id = dimDndId(field);
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.45 : 1,
  };
  return (
    <div
      ref={setNodeRef}
      style={style}
      className="flex items-center gap-1 rounded-lg border border-border/60 bg-card/90 px-2 py-1.5 text-sm shadow-sm"
    >
      <button
        type="button"
        className="touch-none cursor-grab text-muted-foreground hover:text-foreground active:cursor-grabbing rounded p-0.5"
        {...listeners}
        {...attributes}
        aria-label={`Drag ${label}`}
      >
        <GripVertical className="h-4 w-4" />
      </button>
      <span className="min-w-0 flex-1 truncate font-medium text-foreground/90">{label}</span>
      {trailing}
    </div>
  );
}

function DimCheckboxItem({
  field,
  label,
  numeric,
  onAdd,
}: {
  field: string;
  label: string;
  numeric: boolean;
  onAdd: () => void;
}) {
  const id = dimDndId(field);
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.45 : 1,
  };

  const checkboxId = `cb-unselected-${field}`;
  return (
    <div
      ref={setNodeRef}
      style={style}
      className="flex items-center gap-1 rounded-lg border border-border/60 bg-card/90 px-2 py-1.5 text-sm shadow-sm"
    >
      <Checkbox
        id={checkboxId}
        checked={false}
        onCheckedChange={(v) => {
          if (v === true) onAdd();
        }}
      />
      <button
        type="button"
        className="touch-none cursor-grab text-muted-foreground hover:text-foreground active:cursor-grabbing rounded p-0.5"
        {...listeners}
        {...attributes}
        aria-label={`Drag ${label}`}
      >
        <GripVertical className="h-4 w-4" />
      </button>
      <span className="min-w-0 flex-1 truncate font-medium text-foreground/90">{label}</span>
    </div>
  );
}

function FilterFieldRow({
  field,
  label,
  data,
  selected,
  onSelectionChange,
  onRemove,
}: {
  field: string;
  label: string;
  data: Record<string, unknown>[];
  selected: Set<string> | undefined;
  onSelectionChange: (next: Set<string>) => void;
  onRemove: () => void;
}) {
  const options = useMemo(() => {
    const s = new Set<string>();
    for (const r of data) {
      s.add(String(r[field] ?? ''));
    }
    return [...s].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  }, [data, field]);

  const effective = selected ?? new Set(options);

  const toggle = (v: string) => {
    const next = new Set(effective);
    if (next.has(v)) next.delete(v);
    else next.add(v);
    onSelectionChange(next);
  };

  const id = dimDndId(field);
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.45 : 1,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className="flex items-center gap-1 rounded-lg border border-border/60 bg-card/90 px-2 py-1.5 text-sm shadow-sm"
    >
      <button
        type="button"
        className="touch-none cursor-grab text-muted-foreground hover:text-foreground active:cursor-grabbing rounded p-0.5"
        {...listeners}
        {...attributes}
        aria-label={`Drag ${label}`}
      >
        <GripVertical className="h-4 w-4" />
      </button>
      <span className="min-w-0 flex-1 truncate font-medium text-foreground/90">{label}</span>
      <Popover>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="h-7 w-7 shrink-0"
            aria-label={`Filter values for ${label}`}
          >
            <Filter className="h-3.5 w-3.5" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-64 p-3" align="end">
          <div className="mb-2 flex items-center justify-between gap-2">
            <span className="text-xs font-semibold">Include values</span>
            <div className="flex gap-1">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 text-xs"
                onClick={() => onSelectionChange(new Set(options))}
              >
                All
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 text-xs"
                onClick={() => onSelectionChange(new Set())}
              >
                None
              </Button>
            </div>
          </div>
          <ScrollArea className="h-[200px] pr-2">
            <div className="space-y-2">
              {options.map((v) => (
                <div key={v} className="flex items-center gap-2">
                  <Checkbox
                    id={`${field}-${v}`}
                    checked={effective.has(v)}
                    onCheckedChange={() => toggle(v)}
                  />
                  <Label htmlFor={`${field}-${v}`} className="text-xs font-normal truncate cursor-pointer">
                    {v || '(blank)'}
                  </Label>
                </div>
              ))}
            </div>
          </ScrollArea>
        </PopoverContent>
      </Popover>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="h-7 w-7 shrink-0 text-muted-foreground"
        onClick={onRemove}
        aria-label={`Remove ${label} from filters`}
      >
        <X className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}

function ValItem({
  spec,
  label,
  onAggChange,
  onRemove,
}: {
  spec: PivotValueSpec;
  label: string;
  onAggChange: (agg: PivotAgg) => void;
  onRemove: () => void;
}) {
  const id = valDndId(spec);
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.45 : 1,
  };
  return (
    <div
      ref={setNodeRef}
      style={style}
      className="flex items-center gap-1 rounded-lg border border-border/60 bg-card/90 px-2 py-1.5 text-sm shadow-sm"
    >
      <button
        type="button"
        className="touch-none cursor-grab text-muted-foreground hover:text-foreground active:cursor-grabbing rounded p-0.5"
        {...listeners}
        {...attributes}
        aria-label={`Drag ${label}`}
      >
        <GripVertical className="h-4 w-4" />
      </button>
      <span className="min-w-0 flex-1 truncate font-medium text-foreground/90">{label}</span>
      <Select value={spec.agg} onValueChange={(v) => onAggChange(v as PivotAgg)}>
        <SelectTrigger className="h-7 w-[92px] text-xs shrink-0">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="sum">Sum</SelectItem>
          <SelectItem value="mean">Mean</SelectItem>
          <SelectItem value="count">Count</SelectItem>
          <SelectItem value="min">Min</SelectItem>
          <SelectItem value="max">Max</SelectItem>
        </SelectContent>
      </Select>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="h-7 w-7 shrink-0 text-muted-foreground"
        onClick={onRemove}
        aria-label={`Remove ${label}`}
      >
        <X className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}

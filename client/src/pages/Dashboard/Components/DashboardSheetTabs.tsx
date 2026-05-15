import { useEffect, useRef, useState, type CSSProperties } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Edit2,
  FileText,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  horizontalListSortingStrategy,
  sortableKeyboardCoordinates,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { cn } from "@/lib/utils";
import { useDashboardEditMode } from "../context/DashboardEditModeContext";

/**
 * Wave DR5 · horizontal sheet tab strip.
 *
 * Replaces the pre-DR5 left sidebar that consumed 256px of width even
 * for dashboards with a single sheet. Tabs sit above the canvas in a
 * horizontal scroll container; tabs overflowing on narrow viewports
 * scroll horizontally rather than wrap (cleaner for keyboard nav and
 * matches the editor convention).
 *
 * Right-click on a tab opens a context menu (Rename / Move left / Move
 * right / Delete). The menu items respect both `canEdit` permission
 * and view/edit mode — in view mode authoring items are hidden.
 *
 * Reorder ships through `onReorder(orderedSheetIds: string[])` which
 * the consumer wires to `dashboardsApi.reorderSheets`. Drag-to-reorder
 * is deferred to a follow-up wave; the move-left/right items in the
 * context menu cover the use case for now.
 */

interface SheetTab {
  id: string;
  name: string;
  chartCount?: number;
}

interface DashboardSheetTabsProps {
  sheets: SheetTab[];
  activeSheetId: string | null;
  onSelect: (sheetId: string) => void;
  onRename?: (sheetId: string, newName: string) => Promise<void>;
  onDelete?: (sheetId: string) => void;
  onAdd?: () => void;
  onReorder?: (orderedSheetIds: string[]) => Promise<void>;
}

export function DashboardSheetTabs({
  sheets,
  activeSheetId,
  onSelect,
  onRename,
  onDelete,
  onAdd,
  onReorder,
}: DashboardSheetTabsProps) {
  const { mode, canToggle } = useDashboardEditMode();
  const isAuthoring = canToggle && mode === "edit";
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const stripRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (editingId && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editingId]);

  // Keep the active tab in view when the user switches sheets.
  useEffect(() => {
    if (!stripRef.current) return;
    const active = stripRef.current.querySelector<HTMLElement>(
      `[data-sheet-id="${activeSheetId}"]`,
    );
    active?.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "nearest" });
  }, [activeSheetId]);

  const handleStartRename = (id: string, currentName: string) => {
    setEditingId(id);
    setEditName(currentName);
  };

  const handleSaveRename = async (id: string) => {
    if (!onRename) return setEditingId(null);
    const target = sheets.find((s) => s.id === id);
    if (!target) return setEditingId(null);
    const trimmed = editName.trim();
    if (!trimmed || trimmed === target.name) {
      setEditingId(null);
      return;
    }
    setBusy(true);
    try {
      await onRename(id, trimmed);
      setEditingId(null);
    } catch {
      // Toast is handled by caller.
    } finally {
      setBusy(false);
    }
  };

  const handleMove = async (id: string, direction: -1 | 1) => {
    if (!onReorder) return;
    const currentIdx = sheets.findIndex((s) => s.id === id);
    const nextIdx = currentIdx + direction;
    if (currentIdx < 0 || nextIdx < 0 || nextIdx >= sheets.length) return;
    const reordered = [...sheets];
    const [moved] = reordered.splice(currentIdx, 1);
    reordered.splice(nextIdx, 0, moved);
    setBusy(true);
    try {
      await onReorder(reordered.map((s) => s.id));
    } finally {
      setBusy(false);
    }
  };

  // DR12 · drag-to-reorder via dnd-kit. Drag is only enabled in edit
  // mode and only when `onReorder` is supplied; otherwise sensors are
  // unwired so the tab strip behaves identically to pre-DR12.
  const sensors = useSensors(
    useSensor(PointerSensor, {
      // Small activation distance so a click-to-select isn't mistaken
      // for a drag.
      activationConstraint: { distance: 6 },
    }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const dragEnabled = isAuthoring && !!onReorder;
  const sheetIds = sheets.map((s) => s.id);

  const handleDragEnd = async (event: DragEndEvent) => {
    if (!onReorder) return;
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const fromIdx = sheetIds.indexOf(String(active.id));
    const toIdx = sheetIds.indexOf(String(over.id));
    if (fromIdx < 0 || toIdx < 0) return;
    const reordered = arrayMove(sheets, fromIdx, toIdx);
    setBusy(true);
    try {
      await onReorder(reordered.map((s) => s.id));
    } finally {
      setBusy(false);
    }
  };

  /**
   * DR12 · sortable wrapper for a single tab. Pulls drag state from
   * `useSortable` and applies the transform/transition to the tab
   * root. When `dragEnabled` is false the listeners are no-ops so the
   * tab still selects/renames as normal.
   */
  const renderTab = (sheet: SheetTab, idx: number) => {
    const isActive = activeSheetId === sheet.id;
    const isEditingTab = editingId === sheet.id;
    return (
      <SortableTabItem
        key={sheet.id}
        id={sheet.id}
        dragEnabled={dragEnabled && !isEditingTab}
      >
        {({ tabRef, style, listeners, attributes, isDragging }) => (
          <ContextMenu>
            <ContextMenuTrigger asChild>
              <div
                ref={tabRef}
                style={style}
                {...attributes}
                {...listeners}
                role="tab"
                aria-selected={isActive}
                data-sheet-id={sheet.id}
                className={cn(
                  "group flex items-center gap-2 px-3 py-2 border-b-2 transition-colors flex-shrink-0",
                  isActive
                    ? "border-primary text-foreground"
                    : "border-transparent text-muted-foreground hover:text-foreground hover:border-border",
                  dragEnabled && "cursor-grab active:cursor-grabbing",
                  isDragging && "opacity-50",
                )}
              >
                {isEditingTab ? (
                  <div className="flex items-center gap-1">
                    <Input
                      ref={inputRef}
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          handleSaveRename(sheet.id);
                        } else if (e.key === "Escape") {
                          e.preventDefault();
                          setEditingId(null);
                        }
                      }}
                      onClick={(e) => e.stopPropagation()}
                      disabled={busy}
                      className="h-7 text-sm w-32"
                    />
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleSaveRename(sheet.id);
                      }}
                      disabled={busy}
                      className="h-6 w-6"
                      aria-label="Save name"
                    >
                      <Check className="h-3 w-3" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={(e) => {
                        e.stopPropagation();
                        setEditingId(null);
                      }}
                      disabled={busy}
                      className="h-6 w-6"
                      aria-label="Cancel rename"
                    >
                      <X className="h-3 w-3" />
                    </Button>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => onSelect(sheet.id)}
                    onDoubleClick={() => {
                      if (isAuthoring && onRename) handleStartRename(sheet.id, sheet.name);
                    }}
                    className="flex items-center gap-2 text-sm font-medium"
                  >
                    <FileText
                      className={cn(
                        "h-3.5 w-3.5",
                        isActive ? "text-primary" : "text-muted-foreground",
                      )}
                    />
                    <span className="truncate max-w-[180px]">{sheet.name}</span>
                    {sheet.chartCount !== undefined ? (
                      <span className="text-xs text-muted-foreground">
                        · {sheet.chartCount}
                      </span>
                    ) : null}
                  </button>
                )}
              </div>
            </ContextMenuTrigger>
            <ContextMenuContent className="w-48">
              {isAuthoring && onRename ? (
                <ContextMenuItem onSelect={() => handleStartRename(sheet.id, sheet.name)}>
                  <Edit2 className="h-3.5 w-3.5 mr-2" />
                  Rename
                </ContextMenuItem>
              ) : null}
              {isAuthoring && onReorder && idx > 0 ? (
                <ContextMenuItem onSelect={() => handleMove(sheet.id, -1)}>
                  <ArrowLeft className="h-3.5 w-3.5 mr-2" />
                  Move left
                </ContextMenuItem>
              ) : null}
              {isAuthoring && onReorder && idx < sheets.length - 1 ? (
                <ContextMenuItem onSelect={() => handleMove(sheet.id, 1)}>
                  <ArrowRight className="h-3.5 w-3.5 mr-2" />
                  Move right
                </ContextMenuItem>
              ) : null}
              {isAuthoring && onDelete && sheets.length > 1 ? (
                <>
                  <ContextMenuSeparator />
                  <ContextMenuItem
                    onSelect={() => onDelete(sheet.id)}
                    className="text-destructive focus:text-destructive"
                  >
                    <Trash2 className="h-3.5 w-3.5 mr-2" />
                    Delete
                  </ContextMenuItem>
                </>
              ) : null}
            </ContextMenuContent>
          </ContextMenu>
        )}
      </SortableTabItem>
    );
  };

  return (
    <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
      <SortableContext items={sheetIds} strategy={horizontalListSortingStrategy}>
        <div
          className="flex items-center gap-1 border-b border-border overflow-x-auto"
          role="tablist"
          aria-label="Dashboard sheets"
          data-testid="dashboard-sheet-tabs"
          ref={stripRef}
        >
          {sheets.map((sheet, idx) => renderTab(sheet, idx))}

          {isAuthoring && onAdd ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={onAdd}
              aria-label="Add sheet"
              className="h-9 px-2 text-muted-foreground hover:text-foreground flex-shrink-0"
            >
              <Plus className="h-3.5 w-3.5" />
            </Button>
          ) : null}
        </div>
      </SortableContext>
    </DndContext>
  );
}

/**
 * SortableTabItem · render-prop wrapper that hands the tab JSX a ref +
 * style + drag listeners pulled from `useSortable`. Keeps the tab body
 * unchanged structurally so the existing context menu, inline editor,
 * and accessibility attributes don't drift.
 *
 * Drag is disabled when `dragEnabled === false` (view mode, no
 * `onReorder`, OR while the tab is being inline-renamed) — the
 * underlying hook still runs but the tab's `cursor-grab` and
 * `listeners`/`attributes` are stripped to no-ops.
 */
interface SortableTabRenderProps {
  tabRef: (el: HTMLElement | null) => void;
  style: CSSProperties;
  listeners: Record<string, unknown>;
  attributes: Record<string, unknown>;
  isDragging: boolean;
}

function SortableTabItem({
  id,
  dragEnabled,
  children,
}: {
  id: string;
  dragEnabled: boolean;
  children: (p: SortableTabRenderProps) => React.ReactNode;
}) {
  const {
    setNodeRef,
    transform,
    transition,
    isDragging,
    listeners,
    attributes,
  } = useSortable({ id, disabled: !dragEnabled });
  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
  };
  return (
    <>
      {children({
        tabRef: setNodeRef,
        style,
        listeners: dragEnabled
          ? (listeners as unknown as Record<string, unknown>)
          : {},
        attributes: dragEnabled
          ? (attributes as unknown as Record<string, unknown>)
          : {},
        isDragging,
      })}
    </>
  );
}

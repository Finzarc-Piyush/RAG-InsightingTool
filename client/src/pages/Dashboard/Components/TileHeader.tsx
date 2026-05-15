import type { ReactNode } from "react";
import { GripVertical } from "lucide-react";
import { CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { useDashboardEditMode } from "../context/DashboardEditModeContext";

/**
 * Wave DR3 · unified tile header.
 *
 * Pre-DR3 each tile kind owned its own header markup, so the chrome
 * drifted: chart used `text-base text-foreground`, table used
 * `text-sm font-semibold text-primary`, etc. TileHeader standardizes
 * title typography (`text-sm font-semibold text-foreground`),
 * padding (`pb-2 pt-3 px-4`), and the action slot.
 *
 * In view mode the action slot is `aria-hidden` and `opacity-0` (with
 * `pointer-events-none`) rather than removed from the tree — keeps
 * screen-reader narration stable when the user toggles to/from edit
 * mode while focused on a tile, and avoids layout shifts. Hover in
 * edit mode reveals it via group-hover for ergonomics.
 *
 * The drag-grip icon renders only in edit mode AND when the host
 * passes `dragHandleClassName` (the `dashboard-tile-grab-area` class
 * used by react-grid-layout). Its presence does not change the
 * draggability — that's gated separately by the parent through
 * `isDraggable` / `draggableCancel` selectors.
 */

interface TileHeaderProps {
  title: ReactNode;
  /** Right-side action slot — typically edit/delete buttons. */
  actions?: ReactNode;
  /**
   * If set, renders the title with this className on the title node
   * (used by the existing chart kind which uses `text-base`). Defaults
   * to the standard semibold-sm.
   */
  titleClassName?: string;
  /**
   * Padding override; defaults to the standardized `pb-2 pt-3 px-4`.
   */
  className?: string;
  /**
   * Optional helper element rendered between title and actions —
   * e.g. the inapplicable-filter chip from DR4.
   */
  badge?: ReactNode;
}

export function TileHeader({
  title,
  actions,
  badge,
  titleClassName,
  className,
}: TileHeaderProps) {
  const { mode, canToggle } = useDashboardEditMode();
  const showActions = canToggle && mode === "edit" && !!actions;
  return (
    <CardHeader
      className={cn("flex w-full items-center justify-between pb-2 pt-3 px-4", className)}
    >
      <div className="flex items-center justify-between w-full gap-2">
        <CardTitle
          className={cn(
            "text-sm font-semibold text-foreground flex-1 min-w-0 truncate",
            titleClassName,
          )}
        >
          {title}
        </CardTitle>
        {badge ? <div className="flex-shrink-0">{badge}</div> : null}
        {actions ? (
          <div
            className={cn(
              "flex items-center gap-1 flex-shrink-0 transition-opacity",
              showActions
                ? "opacity-0 group-hover:opacity-100"
                : "opacity-0 pointer-events-none",
            )}
            aria-hidden={!showActions}
          >
            {showActions ? actions : null}
          </div>
        ) : null}
        {canToggle && mode === "edit" ? (
          <GripVertical
            className="h-4 w-4 text-muted-foreground/50 flex-shrink-0 cursor-grab"
            aria-hidden="true"
          />
        ) : null}
      </div>
    </CardHeader>
  );
}

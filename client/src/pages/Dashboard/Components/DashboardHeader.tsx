import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  ArrowLeft,
  BarChart3,
  Calendar,
  Check,
  ChevronRight,
  Download,
  Edit2,
  FilePieChart,
  FileText,
  Loader2,
  MoreHorizontal,
  Pencil,
  RefreshCw,
  Share2,
  Sparkles,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { ActiveFilterSpec } from "@/shared/schema";
import { CapturedFilterChip } from "./CapturedFilterBanner";
import { useDashboardEditMode } from "../context/DashboardEditModeContext";
import { OpenChatButton } from "./OpenChatButton";
import type { DashboardData } from "../modules/useDashboardState";

/**
 * Wave DR2 · header restructure.
 *
 * Single sticky row replacing the previous two-row stack + above-canvas
 * provenance banner.
 *
 * Layout:
 *   left   — back arrow, breadcrumb, title (inline-rename), meta line
 *   middle — captured-filter chip (popover; replaces the full-width banner)
 *   right  — edit-mode toggle (when canEdit), summary trigger, export menu,
 *            share, kebab overflow (delete / duplicate)
 *
 * Theming: every accent goes through semantic tokens. The pre-DR2
 * `text-emerald-600 hover:bg-emerald-50` violation on the Share button
 * is fixed here.
 */

interface DashboardHeaderProps {
  name: string;
  lastOpenedAt?: Date;
  updatedAt: Date;
  sheetCount: number;
  isExporting: boolean;
  onBack: () => void;
  onExportPptx: () => void;
  onExportPdf?: () => void;
  isExportingPdf?: boolean;
  onRename?: (newName: string) => Promise<void>;
  onShare?: () => void;
  onDelete?: () => void;
  onOpenSummary?: () => void;
  hasSummary?: boolean;
  capturedActiveFilter?: ActiveFilterSpec;
  /**
   * Wave DR15 · the dashboard reference threaded through to render an
   * "Open chat" back-link. We only need the fields `OpenChatButton`
   * inspects; passing the full `DashboardData` keeps the header's
   * prop surface stable as the linkage logic evolves.
   */
  dashboard?: Pick<DashboardData, "sessionId" | "sheets" | "isShared">;
  /**
   * Wave WR8 (incremental refresh) · "Update data" affordance. When
   * `onUpdateDataFile` is provided a split dropdown is shown: upload an updated
   * file, or (when `hasSnowflakeSource`) re-query Snowflake. Absent → no button.
   */
  onUpdateDataFile?: () => void;
  onUpdateDataSnowflake?: () => void;
  onScheduleRefresh?: () => void;
  hasSnowflakeSource?: boolean;
  isUpdatingData?: boolean;
  /** Wave WR10 · "Data: as of …" version badge + rollback menu (self-contained). */
  dataVersionBadge?: ReactNode;
}

export function DashboardHeader({
  name,
  lastOpenedAt,
  updatedAt,
  sheetCount,
  isExporting,
  onBack,
  onExportPptx,
  onExportPdf,
  isExportingPdf = false,
  onRename,
  onShare,
  onDelete,
  onOpenSummary,
  hasSummary = false,
  capturedActiveFilter,
  dashboard,
  onUpdateDataFile,
  onUpdateDataSnowflake,
  onScheduleRefresh,
  hasSnowflakeSource = false,
  isUpdatingData = false,
  dataVersionBadge,
}: DashboardHeaderProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [editName, setEditName] = useState(name);
  const [isRenaming, setIsRenaming] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const { mode, toggle, canToggle } = useDashboardEditMode();

  useEffect(() => {
    setEditName(name);
  }, [name]);

  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isEditing]);

  const handleSave = async () => {
    if (!onRename || !editName.trim() || editName.trim() === name) {
      setIsEditing(false);
      setEditName(name);
      return;
    }
    setIsRenaming(true);
    try {
      await onRename(editName.trim());
      setIsEditing(false);
    } catch {
      setEditName(name);
    } finally {
      setIsRenaming(false);
    }
  };

  const handleCancel = () => {
    setIsEditing(false);
    setEditName(name);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") handleSave();
    else if (e.key === "Escape") handleCancel();
  };

  const lastTouched = lastOpenedAt ?? updatedAt;
  const lastTouchedFormatted = `${lastTouched.toLocaleDateString()} ${lastTouched.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;

  return (
    <div className="flex flex-wrap items-center gap-3">
      {/* Left: back + breadcrumb + title */}
      <Button
        variant="ghost"
        size="icon"
        onClick={onBack}
        aria-label="Back to dashboards"
        className="flex-shrink-0"
      >
        <ArrowLeft className="h-4 w-4" />
      </Button>

      <div className="flex-1 min-w-[220px]">
        <nav
          aria-label="Breadcrumb"
          className="flex items-center gap-1 text-xs text-muted-foreground"
        >
          <button
            type="button"
            onClick={onBack}
            className="hover:text-foreground transition-colors"
          >
            Dashboards
          </button>
          <ChevronRight className="h-3 w-3" aria-hidden="true" />
          <span className="text-foreground/80">{name}</span>
        </nav>

        {isEditing ? (
          <div className="mt-0.5 flex items-center gap-2">
            <Input
              ref={inputRef}
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              onKeyDown={handleKeyDown}
              disabled={isRenaming}
              className="text-xl font-semibold h-9"
            />
            <Button
              variant="ghost"
              size="icon"
              onClick={handleSave}
              disabled={isRenaming || !editName.trim()}
              className="h-8 w-8"
            >
              <Check className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={handleCancel}
              disabled={isRenaming}
              className="h-8 w-8"
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
        ) : (
          <div className="mt-0.5 flex items-center gap-2 group">
            <h1 className="text-xl font-semibold text-foreground leading-tight">
              {name}
            </h1>
            {onRename && (
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setIsEditing(true)}
                className="h-6 w-6 opacity-0 group-hover:opacity-100 transition-opacity"
                aria-label="Rename dashboard"
              >
                <Edit2 className="h-3 w-3" />
              </Button>
            )}
          </div>
        )}

        <div className="mt-1 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1">
            <Calendar className="h-3.5 w-3.5" />
            Updated {lastTouchedFormatted}
          </span>
          <span className="inline-flex items-center gap-1">
            <BarChart3 className="h-3.5 w-3.5" />
            {sheetCount} view{sheetCount === 1 ? "" : "s"}
          </span>
          {capturedActiveFilter ? (
            <CapturedFilterChip spec={capturedActiveFilter} />
          ) : null}
        </div>
      </div>

      {/* Right: actions */}
      <div className="flex items-center gap-2 ml-auto flex-shrink-0">
        {canToggle ? (
          <Button
            variant={mode === "edit" ? "default" : "outline"}
            size="sm"
            onClick={toggle}
            aria-pressed={mode === "edit"}
            title={
              mode === "edit"
                ? "Exit edit mode (e)"
                : "Enter edit mode (e)"
            }
          >
            <Pencil className="h-4 w-4 mr-2" />
            {mode === "edit" ? "Editing" : "Edit"}
          </Button>
        ) : null}

        {dashboard ? <OpenChatButton dashboard={dashboard} variant="header" /> : null}

        {dataVersionBadge}

        {onUpdateDataFile ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                disabled={isUpdatingData}
                title="Update this analysis with new data"
              >
                {isUpdatingData ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <RefreshCw className="h-4 w-4 mr-2" />
                )}
                Update data
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={onUpdateDataFile}>
                <Upload className="h-4 w-4 mr-2" />
                Upload updated file…
              </DropdownMenuItem>
              {onUpdateDataSnowflake ? (
                <DropdownMenuItem
                  onClick={onUpdateDataSnowflake}
                  disabled={!hasSnowflakeSource}
                  title={
                    hasSnowflakeSource
                      ? "Re-query the table this analysis was built from"
                      : "This analysis isn't connected to Snowflake"
                  }
                >
                  <RefreshCw className="h-4 w-4 mr-2" />
                  Fetch latest from Snowflake
                </DropdownMenuItem>
              ) : null}
              {onScheduleRefresh && hasSnowflakeSource ? (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={onScheduleRefresh}>
                    <Calendar className="h-4 w-4 mr-2" />
                    Auto-refresh…
                  </DropdownMenuItem>
                </>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}

        {hasSummary && onOpenSummary ? (
          <Button
            variant="outline"
            size="sm"
            onClick={onOpenSummary}
            title="Open analysis summary"
          >
            <Sparkles className="h-4 w-4 mr-2" />
            Summary
          </Button>
        ) : null}

        {onShare && (
          <Button
            variant="outline"
            size="sm"
            onClick={onShare}
            className="text-primary hover:bg-primary/10"
          >
            <Share2 className="h-4 w-4 mr-2" />
            Share
          </Button>
        )}

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="default"
              size="sm"
              disabled={isExporting || isExportingPdf}
            >
              {isExporting || isExportingPdf ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <Download className="h-4 w-4 mr-2" />
              )}
              Export
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            <DropdownMenuLabel>Download as</DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={() => onExportPptx()}
              disabled={isExporting}
            >
              <FilePieChart className="h-4 w-4 mr-2" />
              PowerPoint (.pptx)
            </DropdownMenuItem>
            {onExportPdf ? (
              <DropdownMenuItem
                onSelect={() => onExportPdf()}
                disabled={isExportingPdf}
              >
                <FileText className="h-4 w-4 mr-2" />
                PDF
              </DropdownMenuItem>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>

        {onDelete ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                aria-label="More actions"
                className="h-9 w-9"
              >
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
              <DropdownMenuItem
                onSelect={() => onDelete()}
                className="text-destructive focus:text-destructive"
              >
                <Trash2 className="h-4 w-4 mr-2" />
                Delete dashboard
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </div>
    </div>
  );
}

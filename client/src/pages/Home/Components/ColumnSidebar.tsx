import { useState, useMemo } from 'react';
import { Search, Hash, Calendar, Type, X } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

interface ColumnSidebarProps {
  columns?: string[];
  numericColumns?: string[];
  dateColumns?: string[];
  onColumnClick?: (column: string) => void;
  className?: string;
  collapsed?: boolean;
}

export function ColumnSidebar({
  columns = [],
  numericColumns = [],
  dateColumns = [],
  onColumnClick,
  className,
  collapsed = false,
}: ColumnSidebarProps) {
  // All hooks must be called before any conditional returns
  const [searchQuery, setSearchQuery] = useState('');

  // Filter columns based on search query
  const filteredColumns = useMemo(() => {
    if (!searchQuery.trim()) {
      return columns;
    }
    const query = searchQuery.toLowerCase();
    return columns.filter((col) => col.toLowerCase().includes(query));
  }, [columns, searchQuery]);

  // Categorize columns
  const categorizedColumns = useMemo(() => {
    const numeric = filteredColumns.filter((col) => numericColumns.includes(col));
    const date = filteredColumns.filter((col) => dateColumns.includes(col));
    const other = filteredColumns.filter(
      (col) => !numericColumns.includes(col) && !dateColumns.includes(col)
    );

    return { numeric, date, other };
  }, [filteredColumns, numericColumns, dateColumns]);

  // Compact collapsed view - just a vertical "Columns" label
  if (collapsed) {
    return (
      <div
        className={cn(
          'flex h-full items-center justify-center bg-card/80 border-l border-border shadow-sm',
          className
        )}
      >
        <span className="text-[10px] font-medium tracking-[0.18em] text-muted-foreground [writing-mode:vertical-rl] rotate-180">
          COLUMNS
        </span>
      </div>
    );
  }

  const getColumnIcon = (column: string) => {
    if (numericColumns.includes(column)) {
      return <Hash className="w-3.5 h-3.5 text-blue-500" />;
    }
    if (dateColumns.includes(column)) {
      return <Calendar className="w-3.5 h-3.5 text-green-500" />;
    }
    return <Type className="w-3.5 h-3.5 text-muted-foreground" />;
  };

  const handleColumnClick = (column: string) => {
    if (onColumnClick) {
      onColumnClick(column);
    }
  };

  return (
    <div
      className={cn(
        'flex flex-col h-full bg-card border-l border-border shadow-sm',
        className
      )}
    >
      {/* Header */}
      <div className="p-4 border-b border-border bg-muted/30">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold text-foreground">Columns</h2>
          <Badge variant="secondary" className="text-xs">
            {columns.length}
          </Badge>
        </div>
        
        {/* Search Input */}
        <div className="relative">
          <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-muted-foreground w-4 h-4" />
          <Input
            type="text"
            placeholder="Search columns..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-9 pr-8 h-9 text-sm border-border focus:border-primary focus:ring-1 focus:ring-primary"
          />
          {searchQuery && (
            <button
              onClick={() => setSearchQuery('')}
              className="absolute right-2 top-1/2 transform -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>

      {/* Column List */}
      <ScrollArea className="flex-1">
        <div className="p-2">
          {filteredColumns.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              <Search className="w-8 h-8 mx-auto mb-2 text-muted-foreground/50" />
              <p className="text-sm">No columns found</p>
              {searchQuery && (
                <p className="text-xs text-muted-foreground/80 mt-1">
                  Try a different search term
                </p>
              )}
            </div>
          ) : (
            <>
              {/* Numeric Columns */}
              {categorizedColumns.numeric.length > 0 && (
                <div className="mb-4">
                  <div className="flex items-center gap-2 mb-2 px-2">
                    <Hash className="w-3.5 h-3.5 text-blue-500" />
                    <h3 className="text-xs font-semibold text-foreground uppercase tracking-wide">
                      Numeric ({categorizedColumns.numeric.length})
                    </h3>
                  </div>
                  <div className="space-y-1">
                    {categorizedColumns.numeric.map((column) => (
                      <button
                        key={column}
                        onClick={() => handleColumnClick(column)}
                        className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-sm text-left hover:bg-primary/10 hover:text-primary transition-colors group"
                      >
                        {getColumnIcon(column)}
                        <span className="flex-1 truncate text-foreground group-hover:text-primary">
                          {column}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Date Columns */}
              {categorizedColumns.date.length > 0 && (
                <div className="mb-4">
                  <div className="flex items-center gap-2 mb-2 px-2">
                    <Calendar className="w-3.5 h-3.5 text-green-500" />
                    <h3 className="text-xs font-semibold text-foreground uppercase tracking-wide">
                      Date ({categorizedColumns.date.length})
                    </h3>
                  </div>
                  <div className="space-y-1">
                    {categorizedColumns.date.map((column) => (
                      <button
                        key={column}
                        onClick={() => handleColumnClick(column)}
                        className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-sm text-left hover:bg-primary/10 hover:text-primary transition-colors group"
                      >
                        {getColumnIcon(column)}
                        <span className="flex-1 truncate text-foreground group-hover:text-primary">
                          {column}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Other Columns */}
              {categorizedColumns.other.length > 0 && (
                <div className="mb-4">
                  <div className="flex items-center gap-2 mb-2 px-2">
                    <Type className="w-3.5 h-3.5 text-muted-foreground" />
                    <h3 className="text-xs font-semibold text-foreground uppercase tracking-wide">
                      Other ({categorizedColumns.other.length})
                    </h3>
                  </div>
                  <div className="space-y-1">
                    {categorizedColumns.other.map((column) => (
                      <button
                        key={column}
                        onClick={() => handleColumnClick(column)}
                        className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-sm text-left hover:bg-muted/50 hover:text-foreground transition-colors group"
                      >
                        {getColumnIcon(column)}
                        <span className="flex-1 truncate text-foreground group-hover:text-foreground">
                          {column}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </ScrollArea>

      {/* Footer Info */}
      {columns.length > 0 && (
        <div className="p-3 border-t border-border bg-muted/30">
          <p className="text-xs text-muted-foreground text-center">
            {filteredColumns.length === columns.length
              ? `Showing all ${columns.length} columns`
              : `Showing ${filteredColumns.length} of ${columns.length} columns`}
          </p>
        </div>
      )}
    </div>
  );
}


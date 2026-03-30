import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { SharedAnalysesPanel } from '../SharedAnalysesPanel';

interface AnalysisLoadingStateProps {
  onSharedAccepted?: (summary: any) => void;
}

/**
 * Loading skeleton component for the Analysis page
 * Displays placeholder content while sessions are being fetched
 */
export const AnalysisLoadingState = ({ onSharedAccepted }: AnalysisLoadingStateProps) => {
  return (
    <div
      className="flex min-h-0 flex-1 flex-col bg-gradient-to-b from-muted/25 to-background"
      data-analysis-page
    >
      <div className="mx-auto flex min-h-0 w-full max-w-7xl flex-1 flex-col px-4 py-6 sm:px-6">
        {/* Header Skeleton */}
        <div className="flex items-center justify-between mb-6">
          <div className="space-y-2">
            <Skeleton className="h-9 w-64" />
            <Skeleton className="h-5 w-48" />
          </div>
          <Skeleton className="h-10 w-32" />
        </div>

        {/* Search Bar and Sort Skeleton */}
        <div className="flex gap-4 mb-6">
          <Skeleton className="h-12 flex-1" />
          <Skeleton className="h-12 w-[180px]" />
        </div>

        {/* Horizontal Layout: Shared Panel and Sessions List */}
        <div className="flex gap-6 flex-1 min-h-0">
          {/* Left Column: Shared Analyses Panel */}
          <div className="w-96 flex-shrink-0 flex flex-col min-h-0">
            <SharedAnalysesPanel onAccepted={onSharedAccepted} />
          </div>

          {/* Right Column: Sessions List Skeleton */}
          <div className="flex-1 flex flex-col min-w-0">
            <div className="space-y-4 flex-1 overflow-y-auto">
              {Array.from({ length: 3 }).map((_, index) => (
                <Card key={`skeleton-${index}`} className="border-border/80">
                  <CardContent className="p-6">
                    <div className="flex items-start justify-between">
                      <div className="flex-1 space-y-3">
                        <div className="flex items-center gap-3">
                          <Skeleton className="h-5 w-5 rounded" />
                          <Skeleton className="h-6 w-64" />
                          <Skeleton className="h-5 w-16 rounded-full" />
                        </div>
                        <div className="flex items-center gap-4">
                          <Skeleton className="h-4 w-32" />
                          <Skeleton className="h-4 w-24" />
                          <Skeleton className="h-4 w-20" />
                        </div>
                      </div>
                      <div className="flex items-center gap-4">
                        <div className="text-right space-y-2">
                          <Skeleton className="h-4 w-20" />
                          <Skeleton className="h-3 w-16" />
                        </div>
                        <div className="flex items-center gap-2">
                          <Skeleton className="h-8 w-8 rounded" />
                          <Skeleton className="h-8 w-8 rounded" />
                          <Skeleton className="h-8 w-8 rounded" />
                        </div>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};


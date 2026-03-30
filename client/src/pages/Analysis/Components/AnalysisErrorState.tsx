import { FileText } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface AnalysisErrorStateProps {
  onRetry: () => void;
}

export const AnalysisErrorState = ({ onRetry }: AnalysisErrorStateProps) => {
  return (
    <div className="flex min-h-[calc(100vh-4.25rem)] items-center justify-center bg-gradient-to-b from-muted/25 to-background px-4">
      <div className="max-w-md text-center">
        <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-destructive/10">
          <FileText className="h-7 w-7 text-destructive" />
        </div>
        <h2 className="text-xl font-semibold text-foreground">Couldn&apos;t load sessions</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          Check your connection and try again. Your data on the server is unchanged.
        </p>
        <Button onClick={onRetry} variant="default" className="mt-6 rounded-lg">
          Try again
        </Button>
      </div>
    </div>
  );
};

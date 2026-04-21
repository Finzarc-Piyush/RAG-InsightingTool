import { type ChangeEvent, useEffect, useRef, useState } from 'react';
import { Database, Upload, FileSpreadsheet, BarChart3, Lightbulb, MessageCircle } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { useToast } from '@/hooks/use-toast';
import { Display, Caption, Heading } from '@/components/ui/typography';
import { cn } from '@/lib/utils';

interface StartAnalysisViewProps {
  onSelectUpload: (file: File) => void;
  onSelectSnowflake: () => void;
  uploadDialogTrigger?: number;
  isUploadStarting?: boolean;
}

const MAX_BYTES = 500 * 1024 * 1024;

export function StartAnalysisView({
  onSelectUpload,
  onSelectSnowflake,
  uploadDialogTrigger = 0,
  isUploadStarting = false,
}: StartAnalysisViewProps) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const lastTriggerRef = useRef<number>(0);
  const [fileError, setFileError] = useState<string | null>(null);
  const { toast } = useToast();

  const openFilePicker = () => {
    fileInputRef.current?.click();
  };

  const handleFileInputChange = (event: ChangeEvent<HTMLInputElement>) => {
    const selectedFile = event.target.files?.[0];
    if (!selectedFile) return;
    if (selectedFile.size > MAX_BYTES) {
      const msg = 'File must be under 500 MB.';
      setFileError(msg);
      toast({
        title: 'File too large',
        description: msg,
        variant: 'destructive',
      });
      event.target.value = '';
      return;
    }
    setFileError(null);
    onSelectUpload(selectedFile);
    event.target.value = '';
  };

  useEffect(() => {
    if (uploadDialogTrigger > 0 && uploadDialogTrigger !== lastTriggerRef.current) {
      lastTriggerRef.current = uploadDialogTrigger;
      openFilePicker();
    }
  }, [uploadDialogTrigger]);

  return (
    <div className="relative flex min-h-[calc(100vh-4.25rem)] items-center justify-center bg-gradient-canvas p-4 sm:p-8">
      {/* UX-7 · Soft radial halo behind the hero headline. Token-driven;
          vanishes gracefully on narrow viewports. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 h-[60%] bg-gradient-ink-soft opacity-80"
      />
      <div className="relative w-full max-w-2xl">
        <input
          ref={fileInputRef}
          type="file"
          accept=".csv,.xls,.xlsx"
          className="hidden"
          onChange={handleFileInputChange}
        />
        <div className="mb-10 text-center">
          <Display size="lg" as="h1" className="text-balance">
            Ask your data anything.
          </Display>
          {/* UX-7 · The one gold stroke on this page: a 1px hairline under the
              display headline. Kept narrow so it never reads as decoration. */}
          <span
            aria-hidden="true"
            className="mx-auto mt-4 block h-px w-16 bg-[hsl(var(--accent-gold))]"
          />
          <p className="mx-auto mt-5 max-w-lg text-pretty text-[15px] leading-6 text-muted-foreground">
            Connect to Snowflake or upload a spreadsheet to begin.
          </p>
          {fileError && (
            <p className="mt-4 text-sm font-medium text-destructive" role="alert">
              {fileError}
            </p>
          )}
          {isUploadStarting && (
            <p className="mt-4 text-sm font-medium text-primary">
              Uploading… we will open the preview as soon as the server is ready.
            </p>
          )}
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 sm:gap-5">
          <Card
            variant="interactive"
            className="cursor-pointer rounded-brand-2xl border-dashed border-border/80"
            onClick={onSelectSnowflake}
            data-testid="start-snowflake"
          >
            <div className="flex flex-col items-center justify-center px-6 py-10">
              <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-brand-xl bg-primary/10">
                <Database className="h-8 w-8 text-primary" />
              </div>
              <Heading size="md" as="h3" className="mb-2">
                Import from Snowflake
              </Heading>
              <p className="mb-4 text-center text-[13px] leading-5 text-muted-foreground">
                Select a table from your warehouse
              </p>
              <Button
                variant="outline"
                size="sm"
                className="pointer-events-none"
              >
                Connect
              </Button>
            </div>
          </Card>

          <Card
            variant={isUploadStarting ? 'default' : 'interactive'}
            className={cn(
              'rounded-brand-2xl border-dashed border-border/80',
              isUploadStarting ? 'cursor-not-allowed opacity-70' : 'cursor-pointer'
            )}
            onClick={() => {
              if (!isUploadStarting) openFilePicker();
            }}
            data-testid="start-upload"
          >
            <div className="flex flex-col items-center justify-center px-6 py-10">
              <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-brand-xl bg-primary/10">
                <Upload className="h-8 w-8 text-primary" />
              </div>
              <Heading size="md" as="h3" className="mb-2">
                Upload spreadsheet
              </Heading>
              <p className="mb-4 text-center text-[13px] leading-5 text-muted-foreground">
                {isUploadStarting ? 'Upload in progress…' : 'Browse or drop a file'}
              </p>
              <div className="flex items-center gap-2 rounded-full border border-border/80 bg-muted/50 px-3 py-1.5 text-xs text-muted-foreground">
                <FileSpreadsheet className="h-3 w-3 shrink-0" aria-hidden />
                <Caption>CSV, XLS, XLSX · max 500 MB</Caption>
              </div>
            </div>
          </Card>
        </div>

        <div className="mt-8 grid grid-cols-1 gap-3 md:grid-cols-3">
          <div className="rounded-xl border border-border/60 bg-card/80 p-4 text-center shadow-xs">
            <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
              <BarChart3 className="h-5 w-5 text-primary" />
            </div>
            <h4 className="mb-1 text-sm font-semibold text-foreground">
              Assisted analysis
            </h4>
            <p className="text-xs text-muted-foreground">Charts with collaborators</p>
          </div>
          <div className="rounded-xl border border-border/60 bg-card/80 p-4 text-center shadow-xs">
            <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
              <Lightbulb className="h-5 w-5 text-primary" />
            </div>
            <h4 className="mb-1 text-sm font-semibold text-foreground">
              Dashboards & insights
            </h4>
            <p className="text-xs text-muted-foreground">Saved views in one place</p>
          </div>
          <div className="rounded-xl border border-border/60 bg-card/80 p-4 text-center shadow-xs">
            <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
              <MessageCircle className="h-5 w-5 text-primary" />
            </div>
            <h4 className="mb-1 text-sm font-semibold text-foreground">
              Natural-language Q&A
            </h4>
            <p className="text-xs text-muted-foreground">Ask questions in plain language</p>
          </div>
        </div>
      </div>
    </div>
  );
}

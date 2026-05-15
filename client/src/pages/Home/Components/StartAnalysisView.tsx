import { type ChangeEvent, useEffect, useRef, useState } from 'react';
import {
  Database,
  Upload,
  FileSpreadsheet,
  Repeat,
  LayoutDashboard,
  Compass,
  Target,
  TrendingUp,
  BookOpenCheck,
  Workflow,
  Quote,
  type LucideIcon,
} from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { useToast } from '@/hooks/use-toast';
import { Display, Caption, Heading } from '@/components/ui/typography';
import { cn } from '@/lib/utils';

interface StartAnalysisViewProps {
  onSelectUpload: (file: File) => void;
  onSelectSnowflake: () => void;
  /** Wave A12 — open the Automation picker. When undefined, the third card hides. */
  onSelectAutomation?: () => void;
  uploadDialogTrigger?: number;
  isUploadStarting?: boolean;
}

const MAX_BYTES = 500 * 1024 * 1024;

interface CapabilityTile {
  icon: LucideIcon;
  title: string;
  description: string;
}

const CAPABILITY_TILES: CapabilityTile[] = [
  {
    icon: LayoutDashboard,
    title: 'One-prompt dashboards',
    description:
      'Say "Build me a Q3 leadership dashboard" — get an interactive dashboard plus a consultant-grade PPT and PDF, action-titled, methodology in the back.',
  },
  {
    icon: Compass,
    title: 'Decision-grade answers',
    description:
      'Every answer ships with TL;DR, findings, implications grouped by Now / This Quarter / Strategic, magnitudes, and caveats — not just numbers.',
  },
  {
    icon: Target,
    title: 'Business action items',
    description:
      'Beyond "what to analyze next," the tool proposes real-world business decisions, prioritized by horizon and confidence.',
  },
  {
    icon: TrendingUp,
    title: 'Marketing budget optimizer',
    description:
      'Ask where to move your budget — fitted MMM response curves and SLSQP optimization return concrete reallocations with lift estimates.',
  },
  {
    icon: BookOpenCheck,
    title: 'FMCG / Marico domain knowledge',
    description:
      'Knows haircare, premiumisation, channel mix, commodity-cost lag, sub-brand cannibalisation. Pulls in latest market context via web search when useful.',
  },
  {
    icon: Workflow,
    title: 'Multi-step reasoning, verified',
    description:
      'Plans, executes, reflects, verifies, and repairs — like a junior analyst with infinite patience. Watch every step in the thinking panel.',
  },
];

const EXAMPLE_PROMPTS: string[] = [
  'Build me a Q3 haircare leadership dashboard with brand and channel breakdowns.',
  'Why did MARICO sales fall 12% in Q3? Walk me through the drivers.',
  'How do I rescue falling LASHE sales? Give me a real action plan, not just analysis.',
  'Where should I reallocate my Q4 marketing budget across digital, TV, and trade?',
  'Compare premium vs mass shampoo by region this quarter vs last.',
  'Top 10 SKUs by value sales, with each one’s share of the category total.',
];

export function StartAnalysisView({
  onSelectUpload,
  onSelectSnowflake,
  onSelectAutomation,
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
    <div className="relative min-h-[calc(100vh-4.25rem)] bg-gradient-canvas p-4 sm:p-8">
      {/* UX-7 · Soft radial halo behind the hero headline. Token-driven;
          vanishes gracefully on narrow viewports. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 h-[60%] bg-gradient-ink-soft opacity-80"
      />
      <div className="relative mx-auto w-full max-w-7xl">
        <div
          className={cn(
            'grid gap-6 lg:gap-10',
            'lg:grid-cols-[minmax(0,640px)_minmax(0,380px)] lg:items-start lg:justify-center'
          )}
        >
        <main className="mx-auto flex w-full max-w-2xl flex-col">
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
              {onSelectAutomation
                ? 'Connect to Snowflake, upload a spreadsheet, or re-run a saved Automation.'
                : 'Connect to Snowflake or upload a spreadsheet to begin.'}
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

          <div className="grid grid-cols-1 gap-4 sm:gap-5">
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

            {onSelectAutomation && (
              <Card
                variant="interactive"
                className="cursor-pointer rounded-brand-2xl border-dashed border-border/80"
                onClick={onSelectAutomation}
                data-testid="start-automation"
              >
                <div className="flex flex-col items-center justify-center px-6 py-10">
                  <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-brand-xl bg-primary/10">
                    <Repeat className="h-8 w-8 text-primary" />
                  </div>
                  <Heading size="md" as="h3" className="mb-2">
                    Re-Run Existing Automation
                  </Heading>
                  <p className="mb-4 text-center text-[13px] leading-5 text-muted-foreground">
                    Replay a saved chat against new data
                  </p>
                  <Button
                    variant="outline"
                    size="sm"
                    className="pointer-events-none"
                  >
                    Choose
                  </Button>
                </div>
              </Card>
            )}
          </div>
        </main>

        <aside
          aria-label="What this tool can do"
          className="w-full lg:self-start"
        >
          <div className="rounded-brand-2xl border border-border/60 bg-card/80 p-5 shadow-xs">
            <p className="text-[14px] leading-6 text-foreground">
              From a spreadsheet to a board-ready answer — in one prompt.
            </p>
          </div>

          <div className="mt-6">
            <h3 className="mb-3 px-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              What you can do
            </h3>
            <ul className="space-y-2.5">
              {CAPABILITY_TILES.map((tile) => {
                const Icon = tile.icon;
                return (
                  <li
                    key={tile.title}
                    className="rounded-xl border border-border/60 bg-card/80 p-4 shadow-xs"
                  >
                    <div className="flex gap-3">
                      <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10">
                        <Icon className="h-5 w-5 text-primary" />
                      </div>
                      <div className="min-w-0">
                        <h4 className="text-sm font-semibold text-foreground">
                          {tile.title}
                        </h4>
                        <p className="mt-1 text-[13px] leading-5 text-muted-foreground">
                          {tile.description}
                        </p>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        </aside>
        </div>

        <section
          aria-label="Example questions"
          className="mt-6 lg:mt-10"
        >
          <h3 className="mb-3 px-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Try asking…
          </h3>
          <div className="rounded-brand-2xl border border-border/60 bg-card/80 p-5 shadow-xs">
            <ul className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
              {EXAMPLE_PROMPTS.map((prompt) => (
                <li key={prompt} className="flex gap-2.5">
                  <Quote
                    className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary/70"
                    aria-hidden
                  />
                  <p className="text-[13px] leading-5 text-foreground/90">
                    {prompt}
                  </p>
                </li>
              ))}
            </ul>
            <p className="mt-5 border-t border-border/60 pt-3 text-xs text-muted-foreground">
              Upload a spreadsheet or connect Snowflake to begin.
            </p>
          </div>
        </section>
      </div>
    </div>
  );
}

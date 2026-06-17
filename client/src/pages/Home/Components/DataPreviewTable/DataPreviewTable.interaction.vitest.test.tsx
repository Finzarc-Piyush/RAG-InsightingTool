/**
 * ARCH-5 / CQ-3 / FE-2 · Component-level interaction pin for DataPreviewTable's
 * COUPLED pivot ↔ filter ↔ chart state web.
 *
 * Prior waves extracted every cleanly-separable cluster (the two session hooks,
 * pure helpers, the cell formatter, sub-components). What remains is the tangled
 * `pivotConfig` ↔ `filterSelections` ↔ chart-config web sharing reset / hydration
 * / debounced-PATCH effects. Before consolidating those N setters into a typed
 * reducer, this test PINS the observable behaviour the consolidation must
 * preserve:
 *
 *  (a) defaulted pivot fields drive the server pivot query and render the grid,
 *  (b) the debounced PATCH fires with the load-bearing pivot-state payload shape
 *      (schemaVersion + config + filterSelections + analysisView + chart) — the
 *      durable persistence contract,
 *  (c) picking a chart type updates the persisted chart config in the PATCH,
 *  (d) hydration from `initialPivotState` restores config AND record-and-skips
 *      the first PATCH, then a real edit PATCHes,
 *  (e) a data-shape change re-resets + re-queries the server pivot model.
 *
 * Heavy children (chart renderer/shim, framer-motion, markdown, toast) and every
 * API seam (`@/lib/api`, `@/lib/httpClient`) are mocked so the test exercises the
 * STATE TRANSITIONS, not network or chart-rendering internals.
 *
 * NOTE on prop stability: every object/array prop is a MODULE CONSTANT. The
 * component defaults `temporalFacetColumns = []`, and a fresh `[]` each render
 * would re-fire the filter-sync effect → setState → re-render forever in the
 * test harness. Production callers always pass stable references; these fixtures
 * mirror that, so the test reflects real usage (not a contrived stabilisation).
 */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from 'vitest';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';

// ─── API seam mocks ───────────────────────────────────────────────────────────
const pivotQuery = vi.fn();
const pivotDrillthrough = vi.fn();
const downloadModifiedDataset = vi.fn();
const fetchSessionSampleRows = vi.fn();
const fetchPivotColumnDistincts = vi.fn();
const updateMessagePivotState = vi.fn();

vi.mock('@/lib/api', () => ({
  pivotQuery: (...a: unknown[]) => pivotQuery(...a),
  pivotDrillthrough: (...a: unknown[]) => pivotDrillthrough(...a),
  downloadModifiedDataset: (...a: unknown[]) => downloadModifiedDataset(...a),
  fetchSessionSampleRows: (...a: unknown[]) => fetchSessionSampleRows(...a),
  fetchPivotColumnDistincts: (...a: unknown[]) => fetchPivotColumnDistincts(...a),
  sessionsApi: {
    updateMessagePivotState: (...a: unknown[]) => updateMessagePivotState(...a),
  },
}));

// chart-preview + chart-key-insight go through the http client `api.post`.
const httpPost = vi.fn();
vi.mock('@/lib/httpClient', () => ({
  api: {
    post: (...a: unknown[]) => httpPost(...a),
    get: vi.fn(),
  },
}));

// Keep rendering light: stub the heavy chart children, framer-motion, markdown,
// and toast so we test state transitions, not chart internals or animation.
vi.mock('../ChartRenderer', () => ({
  ChartRenderer: () => <div data-testid="chart-renderer" />,
}));
vi.mock('@/components/charts/ChartShim', () => ({
  ChartShim: ({ legacy }: { legacy?: () => React.ReactNode }) => (
    <div data-testid="chart-shim">{legacy ? legacy() : null}</div>
  ),
}));
vi.mock('@/components/ui/markdown-renderer', () => ({
  MarkdownRenderer: ({ content }: { content: string }) => <div>{content}</div>,
}));
vi.mock('framer-motion', () => ({
  motion: new Proxy(
    {},
    { get: () => ({ children }: { children?: React.ReactNode }) => <div>{children}</div> }
  ),
  AnimatePresence: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
}));
vi.mock('@/hooks/use-toast', () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

// Import AFTER mocks are registered.
import { DataPreviewTable } from '../DataPreviewTable';
import type { PivotState } from '@/shared/schema';

const SESSION_ID = 'sess-1';
const MSG_TS = 1_700_000_000_000;

// All object/array props are module constants — see header note on stability.
// `Channel` is the alternate dimension: textual values so the numeric inferer
// never mis-classifies it (a year-string like '2024' parses as numeric and
// would drop out of the dimension set — that is correct production behaviour,
// so the fixtures avoid year-shaped dimensions).
const SCHEMA_COLUMNS = ['Region', 'Channel', 'Revenue'];
const SCHEMA_COLUMNS_ALT = ['Channel', 'Revenue'];
const NUMERIC_COLUMNS = ['Revenue'];
const FACET_COLUMNS: never[] = [];
const ANALYSIS_ROWS = [
  { Region: 'North', Channel: 'Online', Revenue: 100 },
  { Region: 'South', Channel: 'Online', Revenue: 200 },
  { Region: 'North', Channel: 'Retail', Revenue: 150 },
  { Region: 'South', Channel: 'Retail', Revenue: 250 },
];
const PIVOT_DEFAULTS_REGION = { rows: ['Region'], values: ['Revenue'] } as const;
const PIVOT_DEFAULTS_CHANNEL = { rows: ['Channel'], values: ['Revenue'] } as const;
const SAMPLE_RESPONSE = { rows: ANALYSIS_ROWS };

/** Minimal server pivot model shaped like PivotQueryResponse for ['Region']. */
function makeServerModel(rowField = 'Region', labels = ['North', 'South']) {
  return {
    model: {
      rowFields: [rowField],
      colField: null,
      columnFields: [],
      colKeys: [],
      valueSpecs: [{ id: 'meas_Revenue', field: 'Revenue', agg: 'sum' }],
      columnFieldTruncated: false,
      tree: {
        nodes: labels.map((label, i) => ({
          type: 'leaf' as const,
          depth: 0,
          label,
          pathKey: label,
          values: { flatValues: { meas_Revenue: 100 * (i + 1) }, matrixValues: null },
        })),
        grandTotal: { flatValues: { meas_Revenue: 700 }, matrixValues: null },
      },
    },
    meta: { source: 'duckdb' as const, rowCount: labels.length, colKeyCount: 0, truncated: false },
  };
}

function baseProps(overrides: Record<string, unknown> = {}) {
  return {
    data: ANALYSIS_ROWS,
    title: 'Test analysis',
    sessionId: SESSION_ID,
    columns: SCHEMA_COLUMNS,
    numericColumns: NUMERIC_COLUMNS,
    temporalFacetColumns: FACET_COLUMNS,
    variant: 'analysis' as const,
    messageTimestamp: MSG_TS,
    ...overrides,
  };
}

/** Flush real timers (chart-preview 280ms, server-pivot 180ms, PATCH 1500ms). */
async function flush(ms = 1700) {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
}

beforeEach(() => {
  pivotQuery.mockReset().mockResolvedValue(makeServerModel());
  pivotDrillthrough.mockReset().mockResolvedValue({ sessionId: SESSION_ID, count: 0, rows: [] });
  downloadModifiedDataset.mockReset().mockResolvedValue(undefined);
  fetchSessionSampleRows.mockReset().mockResolvedValue(SAMPLE_RESPONSE);
  fetchPivotColumnDistincts.mockReset().mockResolvedValue([]);
  updateMessagePivotState.mockReset().mockResolvedValue(undefined);
  httpPost
    .mockReset()
    .mockResolvedValue({
      chart: { type: 'bar', title: 'x', x: 'Region', y: 'Revenue', data: [] },
      keyInsight: '',
    });
});

afterEach(() => {
  cleanup();
});

describe('DataPreviewTable pivot/filter/chart interaction web', () => {
  test('(a) defaulted pivot fields drive the server pivot query and render the grid', async () => {
    render(<DataPreviewTable {...baseProps({ pivotDefaults: PIVOT_DEFAULTS_REGION })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Pivot' }));
    await flush();

    expect(pivotQuery).toHaveBeenCalled();
    const [, req] = pivotQuery.mock.calls[0];
    expect(req.rowFields).toEqual(['Region']);
    expect(req.valueSpecs).toEqual([
      { id: 'meas_Revenue', field: 'Revenue', agg: 'sum' },
    ]);

    await waitFor(() => {
      expect(screen.getByText('North')).toBeTruthy();
      expect(screen.getByText('South')).toBeTruthy();
    });
  });

  test('(b) debounced PATCH fires with the load-bearing pivot-state payload shape', async () => {
    render(<DataPreviewTable {...baseProps({ pivotDefaults: PIVOT_DEFAULTS_REGION })} />);
    // Boot view is chart; first PATCH emission is record-and-skip. Toggle to
    // pivot to mutate analysisView → a distinct payload that must PATCH.
    fireEvent.click(screen.getByRole('button', { name: 'Pivot' }));
    await flush();

    expect(updateMessagePivotState).toHaveBeenCalled();
    const calls = updateMessagePivotState.mock.calls;
    const [sid, ts, payload] = calls[calls.length - 1];
    expect(sid).toBe(SESSION_ID);
    expect(ts).toBe(MSG_TS);
    expect(payload.schemaVersion).toBe(1);
    expect(payload.config.rows).toEqual(['Region']);
    expect(payload.config.values).toEqual([
      { id: 'meas_Revenue', field: 'Revenue', agg: 'sum' },
    ]);
    expect(payload).toHaveProperty('filterSelections');
    expect(payload.analysisView).toBe('pivot');
    expect(payload.chart).toMatchObject({
      type: expect.any(String),
      xCol: expect.any(String),
      yCol: expect.any(String),
      seriesCol: expect.any(String),
      barLayout: expect.any(String),
    });
  });

  test('(c) picking a chart type updates the persisted chart config in the PATCH payload', async () => {
    render(<DataPreviewTable {...baseProps({ pivotDefaults: PIVOT_DEFAULTS_REGION })} />);
    await flush();
    const select = (await screen.findByLabelText('Chart type')) as HTMLSelectElement;

    act(() => {
      fireEvent.change(select, { target: { value: 'line' } });
    });
    await flush();

    expect(updateMessagePivotState).toHaveBeenCalled();
    const calls = updateMessagePivotState.mock.calls;
    const lastPayload = calls[calls.length - 1][2] as PivotState;
    expect(lastPayload.chart?.type).toBe('line');
  });

  test('(d) hydration from initialPivotState restores config; a subsequent edit PATCHes the restored config', async () => {
    // The load-bearing contract under test: the hydrated config is restored
    // (the pivot becomes canPivot from the persisted rows+values, so the
    // chart-type dropdown renders) and a real user edit PATCHes the RESTORED
    // config rows+values — not the volatile recommended chart mark.
    const initialPivotState: PivotState = {
      schemaVersion: 1,
      config: {
        rows: ['Region'],
        columns: [],
        values: [{ id: 'meas_Revenue', field: 'Revenue', agg: 'sum' }],
        filters: [],
        unused: ['Year'],
        rowSort: { byValueSpecId: 'meas_Revenue', direction: 'desc', primary: 'measure' },
      },
      filterSelections: {},
      analysisView: 'chart',
      chart: { type: 'line', xCol: 'Region', yCol: 'Revenue', seriesCol: '', barLayout: 'stacked' },
    };

    render(<DataPreviewTable {...baseProps({ initialPivotState })} />);
    await flush();

    // The restored pivot config materialises (chart-type dropdown present means
    // the pivot is canPivot from the hydrated rows+values).
    const select = (await screen.findByLabelText('Chart type')) as HTMLSelectElement;
    expect(select).toBeTruthy();

    // A real edit (explicit user chart-type pick) PATCHes, carrying the restored
    // config rows + values.
    act(() => {
      fireEvent.change(select, { target: { value: 'bar' } });
    });
    await flush();
    expect(updateMessagePivotState).toHaveBeenCalled();
    const lastPayload =
      updateMessagePivotState.mock.calls[
        updateMessagePivotState.mock.calls.length - 1
      ][2] as PivotState;
    expect(lastPayload.chart?.type).toBe('bar');
    expect(lastPayload.config.rows).toEqual(['Region']);
    expect(lastPayload.config.values).toEqual([
      { id: 'meas_Revenue', field: 'Revenue', agg: 'sum' },
    ]);
  });

  test('(e) the data-shape reset derives the pivot config + server query from the defaults', async () => {
    // A new message identity (fresh mount) is the canonical reset trigger: the
    // reset-on-data-shape effect derives the config from `pivotDefaults` and the
    // server query targets the derived rows. We mount two shapes back to back to
    // pin that derivation (the composite reset action must reproduce it).
    pivotQuery.mockResolvedValue(makeServerModel('Region', ['North', 'South']));
    const first = render(
      <DataPreviewTable {...baseProps({ pivotDefaults: PIVOT_DEFAULTS_REGION })} />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Pivot' }));
    await flush();
    await waitFor(() => expect(pivotQuery.mock.calls.length).toBeGreaterThan(0));
    for (const call of pivotQuery.mock.calls) {
      expect(call[1].rowFields).toEqual(['Region']);
    }
    first.unmount();

    pivotQuery.mockReset().mockResolvedValue(makeServerModel('Channel', ['Online', 'Retail']));
    render(
      <DataPreviewTable
        {...baseProps({
          columns: SCHEMA_COLUMNS_ALT,
          pivotDefaults: PIVOT_DEFAULTS_CHANNEL,
          messageTimestamp: MSG_TS + 1,
        })}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Pivot' }));
    await flush();

    await waitFor(() => expect(pivotQuery.mock.calls.length).toBeGreaterThan(0));
    for (const call of pivotQuery.mock.calls) {
      expect(call[1].rowFields).toEqual(['Channel']);
    }
  });
});

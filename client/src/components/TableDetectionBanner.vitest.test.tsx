// TableDetectionBanner — render contract for the main-table detection surface.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { TableDetectionBanner } from './TableDetectionBanner';
import type { TableDetection } from '@/shared/schema';

afterEach(() => cleanup());

function detection(overrides: Partial<TableDetection> = {}): TableDetection {
  return {
    headerRowStart: 1,
    headerRowEnd: 1,
    dataRowStart: 2,
    dataRowEnd: 300,
    colStart: 0,
    colEnd: 12,
    confidence: 0.85,
    rationale: 'Main table header at row 2.',
    source: 'tier2',
    nonTrivial: true,
    secondaryTablesIgnored: [],
    ...overrides,
  };
}

describe('TableDetectionBanner', () => {
  it('shows the 1-based header row and skipped-rows detail', () => {
    render(<TableDetectionBanner detection={detection()} />);
    expect(screen.getByText(/main table starting at row 2/i)).toBeTruthy();
    expect(screen.getByText(/skipped 1 title\/junk row/i)).toBeTruthy();
  });

  it('reports an ignored side table', () => {
    render(
      <TableDetectionBanner
        detection={detection({
          secondaryTablesIgnored: [
            { rowStart: 1, rowEnd: 13, colStart: 14, colEnd: 15, reason: 'gap-separated' },
          ],
        })}
      />,
    );
    expect(screen.getByText(/ignored 1 side table/i)).toBeTruthy();
  });

  it('flags low confidence', () => {
    render(<TableDetectionBanner detection={detection({ confidence: 0.4 })} />);
    expect(screen.getByText(/low confidence/i)).toBeTruthy();
  });

  it('shows the rationale only after expanding', () => {
    render(<TableDetectionBanner detection={detection()} />);
    expect(screen.queryByText('Main table header at row 2.')).toBeNull();
    fireEvent.click(screen.getByText(/view detection details/i));
    expect(screen.getByText('Main table header at row 2.')).toBeTruthy();
  });

  it('renders the Adjust button only when onAdjust is provided', () => {
    const onAdjust = vi.fn();
    const { rerender } = render(<TableDetectionBanner detection={detection()} />);
    expect(screen.queryByText(/wrong\? adjust/i)).toBeNull();

    rerender(<TableDetectionBanner detection={detection()} onAdjust={onAdjust} />);
    fireEvent.click(screen.getByText(/wrong\? adjust/i));
    expect(onAdjust).toHaveBeenCalledOnce();
  });
});

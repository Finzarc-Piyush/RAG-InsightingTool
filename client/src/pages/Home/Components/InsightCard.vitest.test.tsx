/**
 * InsightCard · Key Insights panel.
 *
 * W-BOLD2 regression: once the generator bolds EVERY data token, the old
 * `parseInsightSubPoints` (split on every `**…**`) exploded one insight into a
 * stack of one-clause-per-line divs. The render now splits at the em-dash into a
 * headline + detail (≤2 lines) and lets inline bold flow within each line.
 *
 * W-INS-DEDUP regression: a turn could persist the same insight set twice
 * ("7 then the same 7"); the render dedups by normalized text on reload.
 */
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

vi.mock('./DashboardModal/DashboardTableModal', () => ({
  DashboardTableModal: () => null,
}));

import { InsightCard } from './InsightCard';
import type { Insight } from '@/shared/schema';

afterEach(() => cleanup());

describe('InsightCard', () => {
  test('a fully-bolded insight renders as headline + detail, not one line per token', () => {
    const insights: Insight[] = [
      {
        id: 1,
        text:
          '**CSD** has the lowest **GC %** at **28.1%** — **CSD** is the bottom channel below **GT**',
      },
    ];
    const { container } = render(<InsightCard insights={insights} />);
    // The bold tokens survive as inline <strong>, not as separate stacked lines.
    expect(screen.getByText('28.1%').tagName).toBe('STRONG');
    expect(screen.getByText('GT').tagName).toBe('STRONG');
    // Exactly two text rows (headline + detail) inside the insight body — the old
    // bug produced ~6 fragment divs for this string.
    const li = container.querySelector('[data-testid="insight-1"]');
    const rows = li!.querySelectorAll('.flex-1 > div');
    expect(rows.length).toBe(2);
  });

  test('an insight with no em-dash renders as a single headline row', () => {
    const insights: Insight[] = [{ id: 1, text: 'GT leads at 63.4%' }];
    const { container } = render(<InsightCard insights={insights} />);
    const li = container.querySelector('[data-testid="insight-1"]');
    const rows = li!.querySelectorAll('.flex-1 > div');
    expect(rows.length).toBe(1);
  });

  test('drops a duplicated insight tail on reload (7 then the same 7 → 7)', () => {
    const base = Array.from({ length: 4 }, (_, i) => ({ id: i + 1, text: `Insight ${i + 1}` }));
    // Persisted doc carried the same 4 twice (8 total), bold-marker-varied.
    const dupe = base.map((b) => ({ ...b, text: `**${b.text}**` }));
    render(<InsightCard insights={[...base, ...dupe]} />);
    // Header count reflects the deduped total (4), not 8.
    expect(screen.getByText('4 insights')).toBeTruthy();
  });
});

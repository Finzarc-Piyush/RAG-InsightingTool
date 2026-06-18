/**
 * AnswerCard · "Highlight Summary" section.
 *
 * Pins the headline block's new identity: the TL;DR + body render under a
 * titled "Highlight Summary" header (icon + name), mirroring the "Key Insights"
 * section — and the section is omitted when there is no headline content. The
 * narrator's key insight is no longer appended to the body (server-side dedup),
 * so this block does not duplicate it.
 */
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

// Keep rendering light: stub the markdown renderer so we assert on text, not
// markdown internals.
vi.mock('@/components/ui/markdown-renderer', () => ({
  MarkdownRenderer: ({ content }: { content: string }) => <div data-testid="md">{content}</div>,
}));

import { AnswerCard } from './AnswerCard';
import type { Message } from '@/shared/schema';

afterEach(() => cleanup());

function msg(env: Partial<NonNullable<Message['answerEnvelope']>>): Message {
  return { answerEnvelope: env } as unknown as Message;
}

describe('AnswerCard — Highlight Summary', () => {
  test('renders a titled "Highlight Summary" section with the TL;DR and body', () => {
    render(
      <AnswerCard
        message={msg({ tldr: 'Females survived at 74.2% versus 18.9% for males.' })}
        supplementaryMarkdown="The pattern is suggestive but the sample is moderate."
      />
    );
    expect(screen.getByText('Highlight Summary')).toBeTruthy();
    expect(screen.getByText(/Females survived at 74\.2%/)).toBeTruthy();
    expect(screen.getByText(/sample is moderate/)).toBeTruthy();
    // The deduped key insight must NOT appear as an inline bolded label here.
    expect(screen.queryByText(/Key insight:/i)).toBeNull();
  });

  test('omits the Highlight Summary section when there is no headline content', () => {
    render(
      <AnswerCard
        message={msg({ findings: [{ headline: 'A finding', evidence: 'Evidence.' }] })}
      />
    );
    expect(screen.queryByText('Highlight Summary')).toBeNull();
    // The findings section still renders independently.
    expect(screen.getByText('A finding')).toBeTruthy();
  });

  // W-CW2 · the narrator body restates tldr + findings. When structured findings
  // exist, the body paragraph is a duplicate and must be dropped; without
  // findings (synthesis fallback) the body IS the answer and must be kept.
  test('drops the body paragraph when structured findings exist', () => {
    render(
      <AnswerCard
        message={msg({
          tldr: 'Survival was highest in Pclass 1 at 63%.',
          findings: [{ headline: 'Pclass 1 led at 63%', evidence: 'Grouped results.' }],
        })}
        supplementaryMarkdown="Survival rate was 63% in Pclass 1 — a near-verbatim restatement."
      />
    );
    expect(screen.getByText(/Survival was highest/)).toBeTruthy();
    expect(screen.queryByText(/near-verbatim restatement/)).toBeNull();
  });

  test('keeps the body paragraph when there are no structured findings (fallback)', () => {
    render(
      <AnswerCard
        message={msg({ tldr: 'A headline.' })}
        supplementaryMarkdown="This fallback body must still render."
      />
    );
    expect(screen.getByText(/This fallback body must still render/)).toBeTruthy();
  });

  // W-CP1/W-CR1 · the hedged causal lane renders as a distinct, labeled "Why
  // this might be happening" section with a standing disclaimer + per-item basis
  // chip, clearly separate from the measured findings.
  test('renders the "Why this might be happening" section with basis chips', () => {
    render(
      <AnswerCard
        message={msg({
          findings: [{ headline: 'Pclass 1 led at 63%', evidence: 'Grouped results.' }],
          likelyDrivers: [
            {
              explanation:
                'more women survived, consistent with women-and-children-first',
              basis: 'general',
              confidence: 'low',
            },
            {
              explanation: 'likely the Sex split explains part of the gap',
              basis: 'data',
              confidence: 'high',
              testable: true,
            },
          ],
        })}
      />
    );
    expect(screen.getByText('Why this might be happening')).toBeTruthy();
    expect(screen.getByText(/women-and-children-first/)).toBeTruthy();
    expect(screen.getByText('general knowledge')).toBeTruthy();
    expect(screen.getByText('from the data')).toBeTruthy();
    expect(screen.getByText('testable here')).toBeTruthy();
    expect(screen.getByText(/Plausible explanations/)).toBeTruthy();
  });

  test('omits the "Why" section when there are no drivers', () => {
    render(<AnswerCard message={msg({ tldr: 'Just a headline.' })} />);
    expect(screen.queryByText('Why this might be happening')).toBeNull();
  });

  // W-CW2 · machine-precision decimal leaks in finding evidence/magnitude are
  // compacted at render so "0.6296296296296297" never reaches the reader.
  test('compacts raw machine-precision decimals in finding evidence', () => {
    render(
      <AnswerCard
        message={msg({
          findings: [
            {
              headline: 'Pclass 1 survival',
              evidence: 'Grouped results show survival_rate = 0.6296296296296297.',
            },
          ],
        })}
      />
    );
    expect(screen.getByText(/0\.6296\b/)).toBeTruthy();
    expect(screen.queryByText(/0\.6296296296296297/)).toBeNull();
  });
});

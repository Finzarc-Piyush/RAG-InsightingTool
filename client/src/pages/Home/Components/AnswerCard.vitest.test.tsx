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
});

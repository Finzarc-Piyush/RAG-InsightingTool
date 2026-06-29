// RawGridPreview — the header-row correction dialog contract.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { RawGridPreview } from './RawGridPreview';
import type { TableDetection } from '@/shared/schema';

afterEach(() => cleanup());

function detection(): TableDetection {
  return {
    headerRowStart: 1,
    headerRowEnd: 1,
    dataRowStart: 2,
    dataRowEnd: 5,
    colStart: 0,
    colEnd: 2,
    confidence: 0.6,
    rationale: 'r',
    source: 'tier2',
    nonTrivial: true,
    secondaryTablesIgnored: [],
    rawGridPreview: [
      ['Marico India Ltd', '', ''],
      ['Channel', 'Volume', 'NR'],
      ['GT', '176.84', '3.94'],
    ],
  };
}

describe('RawGridPreview', () => {
  it('renders the raw grid cells and pre-selects the detected header', () => {
    render(
      <RawGridPreview open detection={detection()} onOpenChange={() => {}} onConfirm={() => {}} />,
    );
    expect(screen.getByText('Marico India Ltd')).toBeTruthy();
    expect(screen.getByText('Channel')).toBeTruthy();
    // detected header is row index 1 → "Header → row 2"
    expect(screen.getByText(/Header → row 2/)).toBeTruthy();
  });

  it('confirms the user-chosen header row (0-based)', () => {
    const onConfirm = vi.fn();
    render(
      <RawGridPreview open detection={detection()} onOpenChange={() => {}} onConfirm={onConfirm} />,
    );
    // click the first row (the title) → choose row index 0
    fireEvent.click(screen.getByText('Marico India Ltd'));
    expect(screen.getByText(/Header → row 1/)).toBeTruthy();
    fireEvent.click(screen.getByText(/use this row as header/i));
    expect(onConfirm).toHaveBeenCalledWith(0);
  });
});

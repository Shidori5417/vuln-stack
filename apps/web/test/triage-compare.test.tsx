// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CompareView } from '@/components/projects/compare-view';
import { ResultsView } from '@/components/results/results-view';
import { TokensManager } from '@/components/tokens-manager';
import { sampleFindings, sampleReport } from './sample';

afterEach(cleanup);

const [first, second] = sampleFindings;

describe('triage in ResultsView', () => {
  it('shows badges and hides triaged findings by default', async () => {
    const triage = { [first!.fingerprint]: { status: 'false_positive' as const, note: null } };
    render(<ResultsView report={sampleReport} triage={triage} onTriage={vi.fn()} />);
    expect(screen.queryAllByText('minimist')).toHaveLength(0);
    await userEvent.click(screen.getByLabelText(/Hide triaged/));
    expect(screen.getAllByText('minimist').length).toBeGreaterThan(0);
    expect(screen.getAllByText('False positive').length).toBeGreaterThan(0);
  });

  it('marks and clears triage from the detail sheet', async () => {
    const onTriage = vi.fn();
    const triage = { [second!.fingerprint]: { status: 'accepted' as const, note: 'later' } };
    const { rerender } = render(
      <ResultsView report={sampleReport} triage={{}} onTriage={onTriage} />,
    );
    await userEvent.click(screen.getAllByText('minimist')[0]!);
    await userEvent.type(screen.getByLabelText('Note (optional)'), 'not reachable');
    await userEvent.click(screen.getByRole('button', { name: 'Accepted risk' }));
    expect(onTriage).toHaveBeenCalledWith(first!.fingerprint, 'accepted', 'not reachable');
    await userEvent.keyboard('{Escape}');

    rerender(<ResultsView report={sampleReport} triage={triage} onTriage={onTriage} />);
    await userEvent.click(screen.getAllByText('body-parser')[0]!);
    await userEvent.click(screen.getByRole('button', { name: 'Clear triage' }));
    expect(onTriage).toHaveBeenLastCalledWith(second!.fingerprint, null, undefined);
  });

  it('has no triage UI for anonymous scans', async () => {
    render(<ResultsView report={sampleReport} onReset={() => {}} />);
    expect(screen.queryByLabelText(/Hide triaged/)).toBeNull();
    await userEvent.click(screen.getAllByText('minimist')[0]!);
    expect(screen.queryByRole('button', { name: 'Accepted risk' })).toBeNull();
  });
});

describe('CompareView', () => {
  it('lists new, fixed and still open findings with counts', () => {
    render(<CompareView added={[first!]} fixed={sampleFindings.slice(1, 3)} persisting={[]} />);
    expect(screen.getByTestId('compare-summary')).toHaveTextContent(
      '1 new · 2 fixed · 0 still open',
    );
    expect(
      within(screen.getByRole('region', { name: 'New' })).getByText(/minimist@1.0.0/),
    ).toBeInTheDocument();
    expect(
      within(screen.getByRole('region', { name: 'Fixed' })).getByText(/django@1.0.0/),
    ).toBeInTheDocument();
    expect(
      within(screen.getByRole('region', { name: 'Still open' })).getByText('Nothing here.'),
    ).toBeInTheDocument();
  });
});

describe('TokensManager', () => {
  it('shows a new token once', async () => {
    const record = {
      id: 't1',
      name: 'ci',
      prefix: 'vs_abcdefg',
      createdAt: '2026-10-16T10:00:00Z',
      lastUsedAt: null,
      expiresAt: null,
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ token: 'vs_SECRETVALUE', record }, { status: 201 })),
    );
    render(<TokensManager initial={[]} origin="https://vs.example" />);
    await userEvent.type(screen.getByLabelText('Name'), 'ci');
    await userEvent.click(screen.getByRole('button', { name: /Create token/ }));
    expect(await screen.findByText('vs_SECRETVALUE')).toBeInTheDocument();
    expect(screen.getByText(/--api-url https:\/\/vs.example/)).toBeInTheDocument();
    expect(screen.getByText('ci')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByText('vs_SECRETVALUE')).toBeNull();
    vi.unstubAllGlobals();
  });
});

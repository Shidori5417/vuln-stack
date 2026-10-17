// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ResultsView } from '@/components/results/results-view';
import { FileDrop } from '@/components/scan/file-drop';
import { ManualEntry } from '@/components/scan/manual-entry';
import type { PackageRow } from '@/lib/api';
import { sampleReport } from './sample';

afterEach(cleanup);

const rowsOf = () => screen.getAllByRole('row').slice(1);

describe('ResultsView', () => {
  it('shows summary cards and filters the table', async () => {
    const user = userEvent.setup();
    render(<ResultsView report={sampleReport} onReset={() => {}} />);
    expect(screen.getByText(/vulnerabilities in/)).toHaveTextContent(
      '4 vulnerabilities in 4 of 40 dependencies',
    );
    expect(rowsOf()).toHaveLength(4);

    await user.click(screen.getByRole('button', { name: /1\s*Critical/ }));
    expect(rowsOf()).toHaveLength(1);
    expect(screen.getByRole('button', { name: /1\s*Critical/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await user.click(screen.getByRole('button', { name: 'Clear' }));

    await user.selectOptions(screen.getByLabelText('Dependency'), 'transitive');
    expect(rowsOf()).toHaveLength(1);
    expect(within(rowsOf()[0]!).getByText('parent › body-parser')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Clear' }));

    await user.type(screen.getByLabelText('Search findings'), 'django');
    expect(rowsOf()).toHaveLength(1);
    await user.clear(screen.getByLabelText('Search findings'));
    await user.type(screen.getByLabelText('Search findings'), 'zzz');
    expect(screen.getByText('No findings match the filters.')).toBeInTheDocument();
  });

  it('sorts by column and opens the detail panel', async () => {
    const user = userEvent.setup();
    render(<ResultsView report={sampleReport} onReset={() => {}} />);
    await user.click(screen.getByRole('button', { name: 'Package' }));
    expect(within(rowsOf()[0]!).getByText('body-parser')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Package' }));
    expect(within(rowsOf()[0]!).getByText('minimist')).toBeInTheDocument();

    await user.click(within(rowsOf()[0]!).getByText('minimist'));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('minimist summary')).toBeInTheDocument();
    expect(within(dialog).getByRole('link', { name: 'CVE-2021-0001' })).toHaveAttribute(
      'href',
      'https://nvd.nist.gov/vuln/detail/CVE-2021-0001',
    );
    expect(within(dialog).getByText(/Score 9.8 from NVD/)).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('exports JSON, SARIF and PDF', async () => {
    const created: Blob[] = [];
    URL.createObjectURL = vi.fn((b: Blob) => {
      created.push(b);
      return 'blob:x';
    });
    URL.revokeObjectURL = vi.fn();
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const user = userEvent.setup();
    render(<ResultsView report={sampleReport} onReset={() => {}} />);
    for (const name of ['JSON', 'SARIF', 'PDF'])
      await user.click(screen.getByRole('button', { name }));
    expect(click).toHaveBeenCalledTimes(3);
    expect(created.map((b) => b.type)).toEqual([
      'application/json',
      'application/sarif+json',
      'application/pdf',
    ]);
    expect(JSON.parse(await created[1]!.text()).version).toBe('2.1.0');
    expect((await created[2]!.text()).startsWith('%PDF-1.4')).toBe(true);
  });

  it('shows a clean state and notes', () => {
    const onReset = vi.fn();
    render(
      <ResultsView
        report={{
          ...sampleReport,
          findings: [],
          summary: { ...sampleReport.summary, findings: 0 },
        }}
        onReset={onReset}
      />,
    );
    expect(
      screen.getByText('No known vulnerabilities found in 40 dependencies.'),
    ).toBeInTheDocument();
    expect(screen.getByText('Notes (1)')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /New scan/ }));
    expect(onReset).toHaveBeenCalled();
  });
});

function ManualHarness({ initial = [] }: { initial?: PackageRow[] }) {
  const [rows, setRows] = useState(initial);
  return <ManualEntry rows={rows} onChange={setRows} />;
}

describe('ManualEntry', () => {
  it('parses free text into editable rows', async () => {
    globalThis.fetch = vi.fn(
      async () => new Response(JSON.stringify({ suggestions: [] })),
    ) as typeof fetch;
    const user = userEvent.setup();
    render(<ManualHarness />);
    await user.type(
      screen.getByLabelText('Package list'),
      'react 18.2.0, django==4.1, ???bad stuff',
    );
    await user.click(screen.getByRole('button', { name: /Add to list/ }));
    const rows = screen.getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(within(rows[1]!).getByLabelText('Ecosystem')).toHaveValue('PyPI');
    expect(screen.getByText(/Could not read: \?\?\?bad stuff/)).toBeInTheDocument();

    await user.selectOptions(within(rows[0]!).getByLabelText('Ecosystem'), 'NuGet');
    expect(within(screen.getAllByRole('listitem')[0]!).getByLabelText('Ecosystem')).toHaveValue(
      'NuGet',
    );
    await user.click(screen.getByRole('button', { name: 'Remove django' }));
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: /Add row/ }));
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
  });

  it('asks the registry for name suggestions', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ suggestions: [{ name: 'react', version: '19.0.0' }] })),
    );
    globalThis.fetch = fetchMock as typeof fetch;
    const user = userEvent.setup();
    render(<ManualHarness initial={[{ ecosystem: 'npm', name: '', version: '' }]} />);
    await user.type(screen.getByLabelText('Package name'), 'rea');
    await vi.waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('/api/suggest?ecosystem=npm&q=rea'),
        expect.anything(),
      ),
    );
    await vi.waitFor(() =>
      expect(document.querySelector('datalist option')).toHaveAttribute('value', 'react'),
    );
  });
});

describe('FileDrop', () => {
  it('accepts supported files from the picker', async () => {
    const onChange = vi.fn();
    render(<FileDrop files={[]} onChange={onChange} maxBytes={100} />);
    const input = screen.getByTestId('file-input') as HTMLInputElement;
    await userEvent.upload(
      input,
      [new File(['{}'], 'package-lock.json'), new File(['x'], 'notes.txt')],
      { applyAccept: false },
    );
    await vi.waitFor(() => expect(onChange).toHaveBeenCalled());
    expect(onChange.mock.calls[0]![0].map((f: { path: string }) => f.path)).toEqual([
      'package-lock.json',
    ]);
  });

  it('shows sizes, the limit and removal', () => {
    const onChange = vi.fn();
    render(
      <FileDrop
        files={[{ path: 'a/go.mod', content: 'x'.repeat(200), size: 200 }]}
        onChange={onChange}
        maxBytes={100}
      />,
    );
    expect(screen.getByText(/over the 100 B limit/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Remove a/go.mod' }));
    expect(onChange).toHaveBeenCalledWith([]);
  });
});

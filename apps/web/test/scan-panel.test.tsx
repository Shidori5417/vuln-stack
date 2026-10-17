// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ResultsView } from '@/components/results/results-view';
import { ScanPanel } from '@/components/scan/scan-panel';
import { sampleReport } from './sample';

afterEach(cleanup);

describe('ScanPanel sources', () => {
  it('submits a repo body', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn(async () => {});
    render(<ScanPanel onSubmit={onSubmit} />);
    await user.click(screen.getByRole('tab', { name: /GitHub repo/ }));
    const button = screen.getByRole('button', { name: /Scan for vulnerabilities/ });
    expect(button).toBeDisabled();
    await user.type(screen.getByLabelText('GitHub repository'), ' acme/app ');
    await user.click(button);
    expect(onSubmit).toHaveBeenCalledWith({ type: 'repo', url: 'acme/app' }, expect.anything());
  });

  it('offers sign-in or access grant on the private repo error', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn(async () => {
      throw new Error('Repository not found or private. Sign in …');
    });
    const { rerender } = render(<ScanPanel onSubmit={onSubmit} />);
    await user.click(screen.getByRole('tab', { name: /GitHub repo/ }));
    await user.type(screen.getByLabelText('GitHub repository'), 'acme/secret');
    await user.click(screen.getByRole('button', { name: /Scan for vulnerabilities/ }));
    expect(await screen.findByRole('button', { name: 'Sign in with GitHub' })).toBeInTheDocument();
    rerender(<ScanPanel onSubmit={onSubmit} signedIn />);
    expect(
      screen.getAllByRole('button', { name: 'Grant access to private repositories' }).length,
    ).toBeGreaterThan(0);
  });

  it('requires the permission checkbox for website scans', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn(async () => {});
    render(<ScanPanel onSubmit={onSubmit} />);
    await user.click(screen.getByRole('tab', { name: /Website/ }));
    await user.type(screen.getByLabelText('Website address'), 'https://example.com');
    const button = screen.getByRole('button', { name: /Scan for vulnerabilities/ });
    expect(button).toBeDisabled();
    await user.click(screen.getByLabelText('I own this site or have permission to scan it'));
    expect(button).toBeEnabled();
    await user.click(button);
    expect(onSubmit).toHaveBeenCalledWith(
      { type: 'url', url: 'https://example.com', consent: true },
      expect.anything(),
    );
  });
});

describe('Detected technologies', () => {
  it('renders when the report has detections', () => {
    const report = {
      ...sampleReport,
      detected: [
        { name: 'jQuery', version: '3.4.1', source: 'https://x.test/jq.js', confidence: 'medium' },
        { name: 'nginx', source: 'headers', confidence: 'low' },
      ],
    } as typeof sampleReport;
    render(<ResultsView report={report} />);
    expect(screen.getByText('Detected technologies')).toBeInTheDocument();
    expect(screen.getByText('3.4.1')).toBeInTheDocument();
    expect(screen.getByText('version unknown')).toBeInTheDocument();
  });

  it('is hidden without detections', () => {
    render(<ResultsView report={sampleReport} />);
    expect(screen.queryByText('Detected technologies')).not.toBeInTheDocument();
  });
});

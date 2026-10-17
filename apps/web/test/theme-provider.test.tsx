// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ThemeProvider, useTheme } from '@/components/theme-provider';

let dark = false;
let listeners: Array<() => void> = [];

beforeEach(() => {
  dark = false;
  listeners = [];
  localStorage.clear();
  document.documentElement.className = '';
  vi.stubGlobal('matchMedia', () => ({
    get matches() {
      return dark;
    },
    addEventListener: (_: string, cb: () => void) => listeners.push(cb),
    removeEventListener: (_: string, cb: () => void) => {
      listeners = listeners.filter((l) => l !== cb);
    },
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function Probe() {
  const { theme, resolvedTheme, setTheme } = useTheme();
  return (
    <div>
      <span data-testid="state">{`${theme}/${resolvedTheme}`}</span>
      <button onClick={() => setTheme('dark')}>dark</button>
      <button onClick={() => setTheme('light')}>light</button>
    </div>
  );
}

const renderProbe = () =>
  render(
    <ThemeProvider>
      <Probe />
    </ThemeProvider>,
  );

describe('ThemeProvider', () => {
  it('defaults to system and follows prefers-color-scheme changes', () => {
    renderProbe();
    expect(screen.getByTestId('state')).toHaveTextContent('system/light');
    act(() => {
      dark = true;
      listeners.forEach((l) => l());
    });
    expect(screen.getByTestId('state')).toHaveTextContent('system/dark');
    expect(document.documentElement).toHaveClass('dark');
  });

  it('persists explicit choice and toggles the dark class', async () => {
    renderProbe();
    await userEvent.click(screen.getByText('dark'));
    expect(localStorage.getItem('theme')).toBe('dark');
    expect(document.documentElement).toHaveClass('dark');
    await userEvent.click(screen.getByText('light'));
    expect(document.documentElement).not.toHaveClass('dark');
  });

  it('restores the stored theme and survives storage errors', async () => {
    localStorage.setItem('theme', 'dark');
    renderProbe();
    expect(screen.getByTestId('state')).toHaveTextContent('dark/dark');
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    await userEvent.click(screen.getByText('light'));
    expect(screen.getByTestId('state')).toHaveTextContent('light/light');
  });
});

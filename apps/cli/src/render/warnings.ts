import type { Warning } from '@vulnstack/core';
import type { Colors } from './colors.js';

const MAX_SHOWN = 8;

export function renderWarnings(warnings: Warning[], c: Colors): string {
  if (warnings.length === 0) return '';
  const seen = new Set<string>();
  const unique = warnings.filter((w) => {
    const key = `${w.code}|${w.file ?? ''}|${w.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const lines = unique
    .slice(0, MAX_SHOWN)
    .map((w) => c.yellow(`⚠ ${w.file ? `${w.file}: ` : ''}${w.message}`));
  if (unique.length > MAX_SHOWN)
    lines.push(
      c.dim(`  …and ${unique.length - MAX_SHOWN} more warnings (use --format json to see all)`),
    );
  return `${lines.join('\n')}\n`;
}

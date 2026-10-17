import pc from 'picocolors';
import type { Severity } from '@vulnstack/core';

export type Colors = ReturnType<typeof pc.createColors>;

/** Colors only for interactive terminals, honouring NO_COLOR / FORCE_COLOR. */
export function colorsFor(
  stream: { isTTY?: boolean },
  env: Record<string, string | undefined>,
): Colors {
  const forced = env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== '0';
  const enabled =
    forced || (Boolean(stream.isTTY) && env.NO_COLOR === undefined && env.TERM !== 'dumb');
  return pc.createColors(enabled);
}

export function paintSeverity(c: Colors, severity: Severity, text: string): string {
  switch (severity) {
    case 'critical':
      return c.bold(c.magenta(text));
    case 'high':
      return c.bold(c.red(text));
    case 'medium':
      return c.yellow(text);
    case 'low':
      return c.blue(text);
    default:
      return c.dim(text);
  }
}

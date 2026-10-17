import { normalizePypiName } from './versioning.js';

export interface Requirement {
  /** PEP 503 normalised. */
  name: string;
  /** Version specifier, e.g. `>=2.0,<3` ('' = any). */
  spec: string;
  url?: string;
  marker?: string;
}

const REQ_RE =
  /^\s*([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)\s*(?:\[[^\]]*\])?\s*(?:@\s*(\S+))?\s*\(?\s*([^;@()]*?)\s*\)?\s*(?:;\s*(.*))?$/;

/** Parses a PEP 508 requirement string such as `requests[socks]>=2.19; python_version>"3"`. */
export function parseRequirement(text: string): Requirement | undefined {
  const m = REQ_RE.exec(text);
  if (!m) return undefined;
  const req: Requirement = {
    name: normalizePypiName(m[1]!),
    spec: (m[3] ?? '').replace(/\s+/g, ''),
  };
  if (m[2]) req.url = m[2];
  if (m[4]) req.marker = m[4].trim();
  return req;
}

/** `==1.2.3` / `===1.2.3` pins a single version; anything else is a range. */
export function exactVersion(spec: string): string | undefined {
  const m = /^===?([^,*\s]+)$/.exec(spec);
  return m ? m[1] : undefined;
}

/**
 * Poetry constraints to PEP 440: `^1.2.3` → `>=1.2.3,<2.0.0`, `~1.2` → `>=1.2,<1.3`,
 * `1.2.*` stays, a bare version means `==`. Comma/space separated parts are ANDed.
 */
export function poetryToPep440(constraint: string): string {
  const c = constraint.trim();
  if (c === '' || c === '*') return '';
  if (c.includes('||')) return ''; // OR is not expressible as one PEP 440 spec; treat as any
  return c
    .split(/\s*,\s*|\s+(?=[<>=!^~])/)
    .map((part) => {
      const caret = /^\^(\d+)(?:\.(\d+))?(?:\.(\d+))?(.*)$/.exec(part);
      if (caret) {
        const [major, minor, patch] = [caret[1], caret[2], caret[3]].map((x) => Number(x ?? 0)) as [
          number,
          number,
          number,
        ];
        // Poetry: bump the left-most non-zero part (^0 → <1, ^0.0 → <0.1, ^0.0.3 → <0.0.4)
        let upper: string;
        if (major > 0 || caret[2] === undefined) upper = `${major + 1}.0.0`;
        else if (minor > 0 || caret[3] === undefined) upper = `0.${minor + 1}.0`;
        else upper = `0.0.${patch + 1}`;
        return `>=${part.slice(1)},<${upper}`;
      }
      const tilde = /^~(?!=)(\d+)(?:\.(\d+))?(.*)$/.exec(part);
      if (tilde) {
        const major = Number(tilde[1]);
        const upper =
          tilde[2] === undefined ? `${major + 1}.0.0` : `${major}.${Number(tilde[2]) + 1}.0`;
        return `>=${part.slice(1)},<${upper}`;
      }
      if (/^\d/.test(part)) return `==${part}`;
      return part;
    })
    .join(',');
}

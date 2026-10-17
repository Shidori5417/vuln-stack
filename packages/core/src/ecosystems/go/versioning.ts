import semver from 'semver';
import type { Versioning } from '../types.js';
import { caretBreaking, compareWithInvalid } from '../shared.js';

/** Go module versions are semver with a `v` prefix; `+incompatible` is metadata. */
const parse = (v: string) => semver.parse(v.replace(/^v/, '').replace(/\+incompatible$/, ''));

export const goVersioning: Versioning = {
  compare: (a, b) => compareWithInvalid(a, b, parse, (x, y) => semver.compare(x, y)),
  isValid: (v) => parse(v) !== null,
  isMajorBump(from, to) {
    const a = parse(from);
    const b = parse(to);
    if (!a || !b) return true;
    return caretBreaking([a.major, a.minor], [b.major, b.minor]);
  },
  // OSV lists Go versions without the `v` that go.mod uses (stdlib has none).
  displayVersion: (version, current) =>
    current.startsWith('v') && !version.startsWith('v') ? `v${version}` : version,
};

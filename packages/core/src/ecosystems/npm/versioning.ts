import semver from 'semver';
import type { Versioning } from '../types.js';

const parse = (v: string) => semver.parse(v, { loose: true });

export const npmVersioning: Versioning = {
  compare(a, b) {
    const pa = parse(a);
    const pb = parse(b);
    if (pa && pb) return semver.compare(pa, pb);
    if (pa) return 1; // valid versions sort after garbage
    if (pb) return -1;
    return a.localeCompare(b);
  },

  isValid(version) {
    return parse(version) !== null;
  },

  // Follows caret semantics: in 0.x the minor (and in 0.0.x the patch) is the breaking part.
  isMajorBump(from, to) {
    const a = parse(from);
    const b = parse(to);
    if (!a || !b) return true;
    if (a.major !== b.major) return true;
    if (a.major === 0) {
      if (a.minor !== b.minor) return true;
      if (a.minor === 0) return a.patch !== b.patch;
    }
    return false;
  },
};

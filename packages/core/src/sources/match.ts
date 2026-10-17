const patternCache = new Map<string, RegExp>();

/** Matches a file name against names like `package.json` or `*.csproj`. */
export function matchesName(pattern: string, name: string): boolean {
  if (!pattern.includes('*')) return pattern === name;
  let re = patternCache.get(pattern);
  if (!re) {
    const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    re = new RegExp(`^${escaped}$`);
    patternCache.set(pattern, re);
  }
  return re.test(name);
}

export function matchesAny(patterns: readonly string[], name: string): boolean {
  return patterns.some((p) => matchesName(p, name));
}

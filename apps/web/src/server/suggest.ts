import { MemoryCache, type Ecosystem, type FetchFn } from '@vulnstack/core';

export interface Suggestion {
  name: string;
  version?: string;
  description?: string;
}

const cache = new MemoryCache(5000);
const TTL = 60 * 60;

type Source = (q: string, fetch: FetchFn) => Promise<Suggestion[]>;

async function getJson<T>(fetch: FetchFn, url: string): Promise<T | undefined> {
  const res = await fetch(url, {
    headers: { accept: 'application/json', 'user-agent': 'vulnstack-web' },
    signal: AbortSignal.timeout(4000),
  });
  return res.ok ? ((await res.json()) as T) : undefined;
}

const SOURCES: Partial<Record<Ecosystem, Source>> = {
  npm: async (q, fetch) => {
    const data = await getJson<{
      objects?: { package: { name: string; version: string; description?: string } }[];
    }>(fetch, `https://registry.npmjs.org/-/v1/search?size=8&text=${encodeURIComponent(q)}`);
    return (data?.objects ?? []).map(({ package: p }) => ({
      name: p.name,
      version: p.version,
      ...(p.description ? { description: p.description } : {}),
    }));
  },
  Packagist: async (q, fetch) => {
    const data = await getJson<{ results?: { name: string; description?: string }[] }>(
      fetch,
      `https://packagist.org/search.json?per_page=8&q=${encodeURIComponent(q)}`,
    );
    return (data?.results ?? [])
      .slice(0, 8)
      .map((r) => ({ name: r.name, ...(r.description ? { description: r.description } : {}) }));
  },
  NuGet: async (q, fetch) => {
    const data = await getJson<{ data?: { id: string; version: string; description?: string }[] }>(
      fetch,
      `https://azuresearch-usnc.nuget.org/query?take=8&prerelease=false&q=${encodeURIComponent(q)}`,
    );
    return (data?.data ?? []).map((p) => ({
      name: p.id,
      version: p.version,
      ...(p.description ? { description: p.description.slice(0, 140) } : {}),
    }));
  },
  Maven: async (q, fetch) => {
    const data = await getJson<{
      response?: { docs?: { g: string; a: string; latestVersion?: string }[] };
    }>(
      fetch,
      `https://search.maven.org/solrsearch/select?rows=8&wt=json&q=${encodeURIComponent(q)}`,
    );
    return (data?.response?.docs ?? []).map((d) => ({
      name: `${d.g}:${d.a}`,
      ...(d.latestVersion ? { version: d.latestVersion } : {}),
    }));
  },
  // PyPI has no search API: confirm an exact name instead.
  PyPI: async (q, fetch) => {
    const data = await getJson<{ info?: { name: string; version: string; summary?: string } }>(
      fetch,
      `https://pypi.org/pypi/${encodeURIComponent(q)}/json`,
    );
    return data?.info
      ? [
          {
            name: data.info.name,
            version: data.info.version,
            ...(data.info.summary ? { description: data.info.summary } : {}),
          },
        ]
      : [];
  },
};

/** Package name suggestions; empty for ecosystems without a search API (Go). */
export async function suggest(
  ecosystem: Ecosystem,
  query: string,
  fetch: FetchFn = globalThis.fetch,
): Promise<Suggestion[]> {
  const q = query.trim();
  const source = SOURCES[ecosystem];
  if (!source || q.length < 2 || q.length > 100) return [];
  const key = `suggest:${ecosystem}:${q.toLowerCase()}`;
  const hit = await cache.get<Suggestion[]>(key);
  if (hit) return hit;
  try {
    const result = await source(q, fetch);
    await cache.set(key, result, TTL);
    return result;
  } catch {
    return [];
  }
}

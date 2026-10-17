import type { Ecosystem } from '../model/types.js';
import type { OsvRecord } from '../advisories/osv.js';
import { defaultPlugins, pluginFor } from '../ecosystems/registry.js';
import type { EcosystemPlugin } from '../ecosystems/types.js';
import { recordAffects } from '../remediation.js';

/** JSON-able per-ecosystem index of OSV records keyed by normalised package name. */
export interface OfflineIndex {
  ecosystem: Ecosystem;
  builtAt: string;
  packages: Record<string, OsvRecord[]>;
}

const baseEcosystem = (eco: string) => eco.split(':')[0]!;

/** Collects records one by one so callers never hold the raw dump in memory. */
export class OfflineIndexBuilder {
  private readonly packages = new Map<string, OsvRecord[]>();
  private readonly normalize: (name: string) => string;
  count = 0;

  constructor(
    readonly ecosystem: Ecosystem,
    plugins: readonly EcosystemPlugin[] = defaultPlugins,
  ) {
    this.normalize = pluginFor(ecosystem, plugins)?.normalizeName ?? ((n) => n);
  }

  add(record: OsvRecord): void {
    if (record.withdrawn) return;
    const byName = new Map<string, NonNullable<OsvRecord['affected']>>();
    for (const a of record.affected ?? []) {
      if (!a.package || baseEcosystem(a.package.ecosystem) !== this.ecosystem) continue;
      const key = this.normalize(a.package.name);
      const list = byName.get(key) ?? [];
      list.push(a);
      byName.set(key, list);
    }
    if (byName.size === 0) return;
    this.count++;
    for (const [key, affected] of byName) {
      const list = this.packages.get(key) ?? [];
      list.push({ ...record, affected });
      this.packages.set(key, list);
    }
  }

  entries(): IterableIterator<[string, OsvRecord[]]> {
    return this.packages.entries();
  }

  build(builtAt = new Date().toISOString()): OfflineIndex {
    return { ecosystem: this.ecosystem, builtAt, packages: Object.fromEntries(this.packages) };
  }
}

export function buildOfflineIndex(
  ecosystem: Ecosystem,
  records: Iterable<OsvRecord>,
  builtAt?: string,
  plugins?: readonly EcosystemPlugin[],
): OfflineIndex {
  const builder = new OfflineIndexBuilder(ecosystem, plugins);
  for (const r of records) builder.add(r);
  return builder.build(builtAt);
}

export class OfflineDatabase {
  private readonly indexes = new Map<string, OfflineIndex>();

  constructor(
    indexes: Iterable<OfflineIndex>,
    private readonly plugins: readonly EcosystemPlugin[] = defaultPlugins,
  ) {
    for (const i of indexes) this.indexes.set(i.ecosystem, i);
  }

  get ecosystems(): string[] {
    return [...this.indexes.keys()];
  }

  /** Build timestamp per loaded ecosystem. */
  get builtAt(): Record<string, string> {
    return Object.fromEntries([...this.indexes].map(([e, i]) => [e, i.builtAt]));
  }

  query(ecosystem: string, name: string, version: string): OsvRecord[] {
    const index = this.indexes.get(ecosystem);
    const plugin = pluginFor(ecosystem as Ecosystem, this.plugins);
    if (!index || !plugin) return [];
    const key = (plugin.normalizeName ?? ((n: string) => n))(name);
    if (!Object.hasOwn(index.packages, key)) return [];
    return index.packages[key]!.filter((r) =>
      recordAffects(
        r.affected ?? [],
        ecosystem,
        name,
        version,
        plugin.versioning,
        plugin.normalizeName,
      ),
    );
  }
}

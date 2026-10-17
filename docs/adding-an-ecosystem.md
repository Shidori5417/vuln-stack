# Adding an ecosystem

An ecosystem is one `EcosystemPlugin` in `packages/core/src/ecosystems/`. The scanner finds files, hands them to the plugin, and works on the dependency graph it returns. Querying advisories, chains, remediation and reports are shared.

## Checklist

1. Add the id to `Ecosystem` and `ECOSYSTEMS` in `packages/core/src/model/types.ts`, using the **exact ecosystem name OSV.dev expects** (see the [OSV schema](https://ossf.github.io/osv-schema/#affectedpackage-field)), for example `npm`, `PyPI`, `Packagist`, `Maven`, `Go`, `NuGet`, `crates.io`, `RubyGems`.
2. Add the file names to `SUPPORTED_FILES` in `ecosystems/files.ts`.
3. Write `ecosystems/<name>/index.ts` (plugin) and `versioning.ts`.
4. Register the plugin in `defaultPlugins` in `ecosystems/registry.ts`.
5. Add fixtures and tests (below).
6. Add the new id to the `ecosystem` enum in `docs/report-schema.json`, and update the supported-files table in the README. Check any place that switches over `Ecosystem` (the typechecker will point them out).

## The interface

```ts
interface EcosystemPlugin {
  id: Ecosystem;
  displayName: string;
  files: ManifestFiles; // { lock: string[]; manifest: string[] }
  versioning: Versioning;
  parse(input: ParseInput): Promise<ParseOutput>;
  resolveRange?(name: string, range: string, net: NetContext): Promise<string | null>;
  isCoveredByLock?(lockDir: string, memberDir: string, provider: FileProvider): Promise<boolean>;
  normalizeName?(name: string): string;
}
```

### Files

`SUPPORTED_FILES[eco]` has three lists of file **names** (not paths; `*` matches any run of characters, e.g. `*.csproj`):

| List       | Meaning                                                                         |
| ---------- | ------------------------------------------------------------------------------- |
| `lock`     | Lock files in priority order. When any is present, manifests are only context   |
| `manifest` | Manifests with ranges. Used when no lock file exists                            |
| `context`  | Read alongside the others when present (for example `Directory.Packages.props`) |

`plugin.files` takes the lock and manifest lists. Keeping the names in `files.ts` lets the web UI validate uploads without bundling parsers.

### Versioning

```ts
interface Versioning {
  compare(a: string, b: string): number; // <0, 0, >0. Must not throw
  isValid(version: string): boolean;
  isMajorBump(from: string, to: string): boolean;
  displayVersion?(version: string, current: string): string;
}
```

- `compare` must be a total order and never throw. For invalid strings, sort them first (`compareWithInvalid` in `ecosystems/shared.ts`).
- `isMajorBump` decides between **safe patch** and **breaking update** in the report. `caretBreaking` in `shared.ts` implements the common "first non-zero part" rule.
- `displayVersion` shows an advisory's fixed version the way users write it, e.g. Go's `v` prefix, based on the `current` version's style.

### parse()

```ts
parse({ dir, files, provider, allFiles }): Promise<{ subprojects: Subproject[]; warnings: Warning[] }>
```

`dir` is the sub-project folder relative to the scan root (`''` for root), `files` are the matching file paths (lock files first), and `provider.read(path)` returns file content. Return one `Subproject` per scannable unit:

```ts
{ path: dir, ecosystem: 'MyEco', graph, warnings }
```

Build the graph with `createGraph(rootName)`, `addNode` and `addEdge` from `model/graph.ts`:

| Concept      | Rule                                                                                                                      |
| ------------ | ------------------------------------------------------------------------------------------------------------------------- |
| Root         | Edges from `ROOT_ID` point to the **direct** dependencies. Each other edge is parent to child                             |
| `isDirect`   | `true` for dependencies declared by the project, `false` for transitive ones. Keep it consistent with the `ROOT_ID` edges |
| `confidence` | `high` when pinned by a lock file (or given by the user), `medium` when resolved from a range, `low` when guessed         |
| `version`    | Exact version. Use `''` plus `declaredRange` when only a range is known; the scanner then calls `resolveRange`            |
| `scope`      | `prod`, `dev`, `optional` or `peer`. `--no-dev` drops `dev`                                                               |
| `internal`   | `true` for first-party packages such as workspace members: shown in chains, never scanned                                 |
| `sourceFile` | The file the entry came from, used in reports and SARIF locations                                                         |

Skip things that are not registry packages (git branches, local paths, platform requirements) and report them as warnings instead of throwing. Warning codes are stable identifiers shown to users and listed in the report:

| Code                   | Use                                                          |
| ---------------------- | ------------------------------------------------------------ |
| `no-lockfile`          | Only a manifest was found; versions are estimates            |
| `non-registry-version` | A dependency was skipped because it is a branch, path or URL |

Use new descriptive kebab-case codes for other cases. Throw only for unreadable files (for example invalid JSON), with the file name in the message.

### Optional hooks

- `resolveRange(name, range, net)`: pick a concrete version for a manifest range, usually from the registry through `net.fetch` and `net.cache` (use `fetchJson` from `net/http.js` and `DEFAULT_TTL_SECONDS`). Return `null` to leave the dependency unresolved. It is skipped with `--no-resolve`.
- `isCoveredByLock(lockDir, memberDir, provider)`: return `true` when a manifest-only folder is a workspace member already covered by an ancestor's lock file, so it is not reported as lock-less.
- `normalizeName(name)`: canonical package name for advisory matching (PEP 503 for PyPI, lower-case for Packagist). Defaults to the name as written.

## Worked example (hypothetical, not implemented)

A skeleton for a `Cargo` plugin that reads `Cargo.lock` (TOML). **This is an illustration only; VulnStack does not ship it.** It uses `crates.io`, the name OSV uses.

```ts
// packages/core/src/ecosystems/cargo/index.ts (EXAMPLE ONLY)
import { addEdge, addNode, createGraph, ROOT_ID } from '../../model/graph.js';
import type { Warning } from '../../model/types.js';
import { basename, joinPath } from '../../sources/file-provider.js';
import { SUPPORTED_FILES } from '../files.js';
import type { EcosystemPlugin } from '../types.js';
import { cargoVersioning } from './versioning.js';
import { parse as parseToml } from 'smol-toml'; // already a dependency of @vulnstack/core

interface CargoLock {
  package?: { name: string; version: string; source?: string; dependencies?: string[] }[];
}

export const cargoPlugin: EcosystemPlugin = {
  id: 'crates.io', // must be added to the Ecosystem union first
  displayName: 'Cargo (crates.io)',
  files: SUPPORTED_FILES['crates.io'], // { lock: ['Cargo.lock'], manifest: ['Cargo.toml'], context: [] }
  versioning: cargoVersioning, // SemVer: compare, isValid, isMajorBump via caretBreaking

  async parse({ dir, files, provider }) {
    if (!files.map(basename).includes('Cargo.lock')) return { subprojects: [], warnings: [] };
    const lockPath = joinPath(dir, 'Cargo.lock');
    const lock = parseToml(await provider.read(lockPath)) as CargoLock;
    const graph = createGraph(dir ? basename(dir) : 'root');
    const warnings: Warning[] = [];
    const ids = new Map<string, string>();

    for (const pkg of lock.package ?? []) {
      if (!pkg.source) continue; // workspace member or path dependency: not a registry package
      ids.set(
        `${pkg.name}@${pkg.version}`,
        addNode(graph, {
          ecosystem: 'crates.io',
          name: pkg.name,
          version: pkg.version,
          isDirect: false,
          sourceFile: lockPath,
          confidence: 'high',
          scope: 'prod',
        }),
      );
    }
    // Edges: Cargo.lock lists "name version" strings per package (version omitted when unambiguous).
    // Mark packages nobody depends on as direct and link them from ROOT_ID.
    const reached = new Set<string>();
    // ... addEdge(graph, parentId, childId) for each entry in pkg.dependencies, fill `reached` ...
    for (const id of ids.values()) {
      if (reached.has(id)) continue;
      graph.nodes.get(id)!.isDirect = true;
      addEdge(graph, ROOT_ID, id);
    }
    return {
      subprojects: [{ path: dir, ecosystem: 'crates.io', graph, warnings: [] }],
      warnings,
    };
  },
};
```

Then register it in `registry.ts`:

```ts
export const defaultPlugins = [npmPlugin /* … */, cargoPlugin];
```

## Fixtures and tests

- Put realistic files under `fixtures/<eco>/<case>/`. Prefer files generated by the real tool; hand-written ones must say so. Versions are usually known-vulnerable on purpose and **must never be installed**.
- Add `fixtures/<eco>/README.md` with a table like the existing ones:

  | Folder   | What it covers                                     |
  | -------- | -------------------------------------------------- |
  | `locked` | `Cargo.lock` with a workspace member, a git source |

- Add `packages/core/test/<eco>.test.ts`. Cover: lock file graph and chains, `isDirect`, scopes, manifest-only fallback with the `no-lockfile` warning, skipped non-registry entries, version comparison edge cases (pre-releases, epochs, build metadata) and `isMajorBump`. Use `FIXTURES` and `fakeOsv` from `test/helpers.ts`; tests must not use the network.
- Run `pnpm test`, `pnpm typecheck` and `pnpm lint` before opening a PR.

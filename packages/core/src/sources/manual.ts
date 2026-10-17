import { addEdge, addNode, createGraph, ROOT_ID } from '../model/graph.js';
import type { Ecosystem, Subproject } from '../model/types.js';

export interface ManualEntry {
  ecosystem: Ecosystem;
  /** False when the ecosystem was guessed; UIs should let the user correct it. */
  ecosystemExplicit: boolean;
  name: string;
  /** Empty when the user gave no version. */
  version: string;
  raw: string;
}

export interface ManualParseResult {
  entries: ManualEntry[];
  errors: { raw: string; message: string }[];
}

const ECOSYSTEM_ALIASES: Record<string, Ecosystem> = {
  npm: 'npm',
  node: 'npm',
  js: 'npm',
  pypi: 'PyPI',
  pip: 'PyPI',
  python: 'PyPI',
  py: 'PyPI',
  packagist: 'Packagist',
  composer: 'Packagist',
  php: 'Packagist',
  maven: 'Maven',
  java: 'Maven',
  gradle: 'Maven',
  go: 'Go',
  golang: 'Go',
  nuget: 'NuGet',
  dotnet: 'NuGet',
  '.net': 'NuGet',
  rubygems: 'RubyGems',
  gem: 'RubyGems',
  ruby: 'RubyGems',
  bundler: 'RubyGems',
  'crates.io': 'crates.io',
  crates: 'crates.io',
  cargo: 'crates.io',
  rust: 'crates.io',
  hex: 'Hex',
  elixir: 'Hex',
  erlang: 'Hex',
  mix: 'Hex',
  pub: 'Pub',
  dart: 'Pub',
  flutter: 'Pub',
  swift: 'SwiftURL',
  swifturl: 'SwiftURL',
  spm: 'SwiftURL',
};

/** Popular packages whose names alone identify a non-npm ecosystem. */
const KNOWN_PYPI = new Set([
  'django',
  'flask',
  'fastapi',
  'requests',
  'numpy',
  'pandas',
  'scipy',
  'pillow',
  'sqlalchemy',
  'celery',
  'jinja2',
  'werkzeug',
  'pyyaml',
  'urllib3',
  'cryptography',
  'pydantic',
  'uvicorn',
  'gunicorn',
  'boto3',
  'tensorflow',
  'torch',
  'scikit-learn',
  'aiohttp',
  'httpx',
  'paramiko',
]);
const KNOWN_NUGET = /^(Microsoft|System|Newtonsoft|NuGet|Serilog|AutoMapper|Dapper)\./;

export function guessEcosystem(name: string): Ecosystem {
  if (name.startsWith('@')) return 'npm';
  if (/^[a-z0-9.-]+\.[a-z]{2,}\/[^/]+\/?/i.test(name)) return 'Go'; // github.com/x/y, golang.org/x/net
  if (/^[\w.-]+:[\w.-]+$/.test(name)) return 'Maven'; // group:artifact
  if (/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(name)) return 'Packagist'; // vendor/package
  if (KNOWN_NUGET.test(name)) return 'NuGet';
  if (KNOWN_PYPI.has(name.toLowerCase())) return 'PyPI';
  return 'npm';
}

function parseToken(raw: string): ManualEntry | string {
  let text = raw.trim();
  let ecosystem: Ecosystem | undefined;

  // Optional "eco:" prefix — only if the part before ':' is a known ecosystem
  // (so Maven's group:artifact is left alone).
  const prefix = /^([a-z.]+):(.+)$/i.exec(text);
  if (prefix && ECOSYSTEM_ALIASES[prefix[1]!.toLowerCase()]) {
    ecosystem = ECOSYSTEM_ALIASES[prefix[1]!.toLowerCase()];
    text = prefix[2]!.trim();
  }

  let name: string;
  let version = '';
  const pep = /^([^=\s]+)\s*==\s*(\S+)$/.exec(text);
  const spaced = /^(\S+)\s+v?(\S+)$/.exec(text);
  const at = /^(@?[^@\s]+)@v?(\S*)$/.exec(text);
  if (pep) {
    name = pep[1]!;
    version = pep[2]!;
    ecosystem ??= 'PyPI';
  } else if (spaced) {
    name = spaced[1]!;
    version = spaced[2]!;
  } else if (at) {
    name = at[1]!;
    version = at[2]!;
  } else if (/^\S+$/.test(text)) {
    name = text;
  } else {
    return `Could not understand "${raw.trim()}"`;
  }

  // Maven written as group:artifact:version
  if (!ecosystem && !version) {
    const gav = /^([\w.-]+:[\w.-]+):([\w.-]+)$/.exec(name);
    if (gav) {
      name = gav[1]!;
      version = gav[2]!;
      ecosystem = 'Maven';
    }
  }

  // Package names across ecosystems: letters, digits and . _ - / : @ (scopes, Maven, Go paths).
  if (!/^@?[A-Za-z0-9][\w.\-/:@]*$/.test(name)) return `"${name}" is not a valid package name`;
  // Versions start with a digit (optionally after `v`); `latest` / `*` mean "resolve it".
  if (version && !/^(v?\d[\w.\-+~!]*|latest|\*)$/i.test(version))
    return `"${version}" is not a valid version`;

  return {
    ecosystem: ecosystem ?? guessEcosystem(name),
    ecosystemExplicit: ecosystem !== undefined,
    name,
    version: version === 'latest' || version === '*' ? '' : version,
    raw: raw.trim(),
  };
}

/** Parses "react@18.2.0, express 4.17.1, pypi:django==4.1" (commas or newlines). */
export function parseManualInput(text: string): ManualParseResult {
  const result: ManualParseResult = { entries: [], errors: [] };
  for (const raw of text.split(/[,\n;]/)) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    const parsed = parseToken(raw);
    if (typeof parsed === 'string') result.errors.push({ raw: raw.trim(), message: parsed });
    else result.entries.push(parsed);
  }
  return result;
}

/** One subproject per ecosystem, all entries direct. */
export function manualSubprojects(entries: ManualEntry[]): Subproject[] {
  const byEco = new Map<Ecosystem, Subproject>();
  for (const entry of entries) {
    let sub = byEco.get(entry.ecosystem);
    if (!sub) {
      sub = {
        path: 'manual',
        ecosystem: entry.ecosystem,
        graph: createGraph('manual'),
        warnings: [],
      };
      byEco.set(entry.ecosystem, sub);
    }
    const id = addNode(sub.graph, {
      ecosystem: entry.ecosystem,
      name: entry.name,
      version: entry.version,
      isDirect: true,
      sourceFile: 'manual input',
      confidence: entry.version ? 'high' : 'medium',
      ...(entry.version ? {} : { declaredRange: '*' }),
    });
    addEdge(sub.graph, ROOT_ID, id);
  }
  return [...byEco.values()];
}

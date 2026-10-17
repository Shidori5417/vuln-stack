import { readFile, stat, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import {
  applyIgnores,
  exceedsThreshold,
  formatJson,
  formatSarif,
  ignoreRulesFromIds,
  MemoryCache,
  parseIgnoreFile,
  renderPdfReport,
  toJsonReport,
  scanFiles,
  parseGitHubUrl,
  scanGitHubRepo,
  scanManual,
  summarize,
  isKnownExploited,
  scanWebsite,
  type FailLevel,
  type IgnoreRule,
  type ScanOptions,
  type ScanPhase,
  type ScanResult,
  type Warning,
} from '@vulnstack/core';
import {
  FileCache,
  FsFileProvider,
  loadExploitData,
  nodeResolve,
  openOfflineDatabase,
} from '@vulnstack/core/node';
import { offlineDir } from './db.js';
import { EXIT_ERROR, EXIT_FINDINGS, EXIT_OK, type CliIO } from '../io.js';
import { createFetch, createPinnedFetch } from '../net.js';
import { colorsFor } from '../render/colors.js';
import { renderReport } from '../render/table.js';
import { normalizeApiUrl, uploadReport } from './upload.js';
import { renderWarnings } from '../render/warnings.js';

export const FORMATS = ['table', 'json', 'sarif', 'pdf'] as const;
export type Format = (typeof FORMATS)[number];

export interface ScanCommandOptions {
  manual?: string;
  repo?: string;
  url?: string;
  iOwnThisSite?: boolean;
  retire?: boolean;
  format: Format;
  output?: string;
  dev: boolean;
  cache: boolean;
  resolve: boolean;
  ghsa: boolean;
  /** undefined = on when NVD_API_KEY is set */
  nvd?: boolean;
  nvdTimeout: number;
  failOn?: FailLevel;
  ignore: string[];
  ignoreFile?: string;
  upload?: boolean;
  project?: string;
  apiUrl?: string;
  offline?: boolean;
  offlineDir?: string;
  /** Commander `--no-kev` / `--no-epss`: true unless disabled. */
  kev?: boolean;
  epss?: boolean;
  kevOnly?: boolean;
  /** 0..1 */
  minEpss?: number;
  failOnKev?: boolean;
}

export const IGNORE_FILE = '.vulnstackignore';

/**
 * Rules from --ignore plus the ignore file: an explicit --ignore-file must exist,
 * the default `.vulnstackignore` in the scanned folder is optional.
 */
export async function loadIgnoreRules(
  options: Pick<ScanCommandOptions, 'ignore' | 'ignoreFile'>,
  baseDir: string,
  cwd: string,
  lookupDefault = true,
): Promise<{ rules: IgnoreRule[]; warnings: Warning[] }> {
  const rules = ignoreRulesFromIds(options.ignore);
  if (!options.ignoreFile && !lookupDefault) return { rules, warnings: [] };
  const path = options.ignoreFile
    ? resolve(cwd, options.ignoreFile)
    : resolve(baseDir, IGNORE_FILE);
  let content: string | undefined;
  try {
    content = await readFile(path, 'utf8');
  } catch (error) {
    if (options.ignoreFile)
      throw new Error(
        `Cannot read ignore file ${options.ignoreFile}: ${(error as Error).message}`,
        {
          cause: error,
        },
      );
  }
  if (content === undefined) return { rules, warnings: [] };
  const parsed = parseIgnoreFile(content, options.ignoreFile ?? IGNORE_FILE);
  return { rules: [...rules, ...parsed.rules], warnings: parsed.warnings };
}
/** Advisory sources beyond OSV, configured from flags and environment. */
export function sourceOptions(
  options: ScanCommandOptions,
  env: CliIO['env'],
): Pick<ScanOptions, 'ghsa' | 'nvd'> {
  const out: Pick<ScanOptions, 'ghsa' | 'nvd'> = {};
  const token = env.VULNSTACK_GITHUB_TOKEN || env.GITHUB_TOKEN || env.GH_TOKEN;
  if (options.ghsa && token) out.ghsa = { token };
  const apiKey = env.NVD_API_KEY;
  if (options.nvd ?? Boolean(apiKey)) {
    out.nvd = { maxWaitMs: options.nvdTimeout * 1000, ...(apiKey ? { apiKey } : {}) };
  }
  return out;
}

const PHASE_TEXT: Record<ScanPhase, string> = {
  parse: 'Reading dependency files',
  resolve: 'Resolving versions',
  query: 'Querying OSV.dev',
  details: 'Fetching advisory details',
  enrich: 'Fetching CVSS scores from NVD',
  done: '',
};

const CONSENT_TEXT = `--url runs a passive fingerprint of a website: one GET of the page plus up to
20 public JavaScript/CSS assets (same site or well-known CDNs). No active
probing, no crawling, no authentication. Private/internal addresses are refused.
Only scan sites you own or have permission to test. Confirm with
--i-own-this-site (or VULNSTACK_URL_CONSENT=1).
`;

function progressReporter(io: CliIO, enabled: boolean, parseText = 'Reading dependency files') {
  if (!enabled) return { update: undefined, clear: () => {} };
  let shown = false;
  return {
    update: (phase: ScanPhase, detail?: string) => {
      const text = phase === 'parse' ? parseText : PHASE_TEXT[phase];
      io.stderr.write(`\r\x1b[K${text ? `${text}${detail ? ` (${detail})` : ''}…` : ''}`);
      shown = Boolean(text);
    },
    clear: () => {
      if (shown) io.stderr.write('\r\x1b[K');
    },
  };
}

function defaultProject(options: ScanCommandOptions, target: string): string {
  if (options.repo) return parseGitHubUrl(options.repo).repo;
  if (options.url) {
    const raw = /^https?:\/\//i.test(options.url) ? options.url : `https://${options.url}`;
    return new URL(raw).hostname;
  }
  return options.manual ? 'manual' : basename(target);
}

export async function runScan(
  path: string | undefined,
  options: ScanCommandOptions,
  io: CliIO,
): Promise<number> {
  if (options.kevOnly && options.kev === false) {
    io.stderr.write('✖ --kev-only cannot be combined with --no-kev.\n');
    return EXIT_ERROR;
  }
  if (options.failOnKev && options.kev === false) {
    io.stderr.write('✖ --fail-on-kev cannot be combined with --no-kev.\n');
    return EXIT_ERROR;
  }
  if (options.minEpss !== undefined && options.epss === false) {
    io.stderr.write('✖ --min-epss cannot be combined with --no-epss.\n');
    return EXIT_ERROR;
  }
  const modes = [
    path !== undefined,
    Boolean(options.manual),
    Boolean(options.repo),
    Boolean(options.url),
  ];
  if (modes.filter(Boolean).length > 1) {
    io.stderr.write(
      '✖ [path], --manual, --repo and --url are mutually exclusive; use only one of them.\n',
    );
    return EXIT_ERROR;
  }
  if (options.offline && options.url) {
    io.stderr.write(
      '✖ --offline cannot be combined with --url (fingerprinting needs the network).\n',
    );
    return EXIT_ERROR;
  }
  if (options.retire && !options.url) {
    io.stderr.write('✖ --retire only works together with --url.\n');
    return EXIT_ERROR;
  }
  if (options.url) {
    const consent = options.iOwnThisSite || io.env.VULNSTACK_URL_CONSENT === '1';
    if (!consent) {
      io.stderr.write(CONSENT_TEXT);
      return EXIT_ERROR;
    }
  }
  const remote = Boolean(options.repo || options.url);
  let uploadTarget: { apiUrl: string; token: string } | undefined;
  if (options.upload) {
    const rawUrl = options.apiUrl ?? io.env.VULNSTACK_API_URL;
    if (!rawUrl) throw new Error('--upload needs --api-url or the VULNSTACK_API_URL env variable');
    const token = io.env.VULNSTACK_TOKEN;
    if (!token)
      throw new Error(
        '--upload needs the VULNSTACK_TOKEN env variable (create one in the web app under Settings → API tokens)',
      );
    uploadTarget = { apiUrl: normalizeApiUrl(rawUrl), token };
  }
  const progress = progressReporter(
    io,
    Boolean(io.stderr.isTTY) && !io.env.CI,
    options.repo ? 'Reading repository' : options.url ? 'Fetching page' : undefined,
  );
  const scanOptions: ScanOptions = {
    cache: io.cache ?? (options.cache ? new FileCache() : new MemoryCache()),
    includeDev: options.dev,
    resolveRanges: options.resolve,
    ...sourceOptions(options, io.env),
    kev: options.kev !== false,
    epss: options.epss !== false,
  };
  const fetch = io.fetch ?? createFetch(io.env);
  if (fetch) scanOptions.fetch = fetch;
  if (progress.update) scanOptions.onProgress = progress.update;

  const target = resolve(io.cwd, path ?? '.');
  if (!options.manual && !remote) {
    const info = await stat(target).catch(() => undefined);
    if (!info?.isDirectory()) throw new Error(`${path ?? '.'} is not a directory`);
  }

  if (options.format === 'pdf' && !options.output && io.stdout.isTTY) {
    throw new Error('PDF output is binary; use --output report.pdf (or redirect stdout)');
  }
  const ignores = await loadIgnoreRules(
    options,
    options.manual || remote ? io.cwd : target,
    io.cwd,
    !remote,
  );

  // Offline: indexes are loaded lazily, per ecosystem actually queried.
  if (options.offline) {
    const dir = offlineDir(options.offlineDir, io.cwd);
    const db = await openOfflineDatabase(dir);
    // A missing KEV/EPSS file becomes one `offline-missing-exploit-data` warning from core.
    const exploit = scanOptions.kev || scanOptions.epss ? await loadExploitData(dir) : undefined;
    scanOptions.offline = {
      query: (eco, name, version) => db.query(eco, name, version),
      warnings: () => db.warnings(),
      builtAt: { ...db.builtAt, ...exploit?.builtAt },
      ...(exploit ? { exploit } : {}),
    };
  }

  let scanned: ScanResult;
  try {
    if (options.repo) {
      const token = io.env.VULNSTACK_GITHUB_TOKEN || io.env.GITHUB_TOKEN || io.env.GH_TOKEN;
      scanned = await scanGitHubRepo(options.repo, { ...scanOptions, ...(token ? { token } : {}) });
    } else if (options.url) {
      scanned = await scanWebsite(options.url, {
        ...scanOptions,
        fetch: io.fetch ?? createPinnedFetch(io.env),
        resolve: io.resolve ?? nodeResolve,
        ...(options.retire ? { retire: true } : {}),
      });
    } else
      scanned = options.manual
        ? await scanManual(options.manual, scanOptions)
        : await scanFiles(new FsFileProvider(target), scanOptions);
  } finally {
    progress.clear();
  }
  const afterIgnores = applyIgnores(
    { ...scanned, warnings: [...scanned.warnings, ...ignores.warnings] },
    ignores.rules,
  );
  // --fail-on-kev looks at what remains after ignores, before display filters.
  const hasKev = afterIgnores.findings.some((f) => isKnownExploited(f.vulnerability));
  let result = afterIgnores;
  if (options.kevOnly || options.minEpss !== undefined) {
    const findings = afterIgnores.findings.filter(
      (f) =>
        (!options.kevOnly || isKnownExploited(f.vulnerability)) &&
        (options.minEpss === undefined || (f.vulnerability.exploit?.epss ?? 0) >= options.minEpss),
    );
    result = {
      ...afterIgnores,
      findings,
      summary: summarize(afterIgnores.subprojects, findings),
    };
  }

  const toFile = Boolean(options.output);
  let rendered: string | Uint8Array;
  switch (options.format) {
    case 'json':
      rendered = formatJson(result);
      break;
    case 'sarif':
      rendered = formatSarif(result);
      break;
    case 'pdf':
      rendered = renderPdfReport(
        result,
        options.manual || remote ? {} : { title: basename(target) },
      );
      break;
    default:
      rendered = renderReport(result, {
        colors: colorsFor(toFile ? {} : io.stdout, io.env),
        width: toFile ? 120 : (io.stdout.columns ?? 120),
        ...(io.prog ? { prog: io.prog } : {}),
      });
  }

  if (options.output) {
    await writeFile(resolve(io.cwd, options.output), rendered);
    io.stderr.write(`Report written to ${options.output}\n`);
  } else {
    io.stdout.write(rendered);
  }
  io.stderr.write(renderWarnings(result.warnings, colorsFor(io.stderr, io.env)));

  let uploadFailed = false;
  if (uploadTarget) {
    const c = colorsFor(io.stderr, io.env);
    try {
      const { url } = await uploadReport({
        ...uploadTarget,
        project: options.project ?? defaultProject(options, target),
        report: toJsonReport(result),
        fetch: io.fetch ?? createFetch(io.env) ?? globalThis.fetch,
      });
      io.stderr.write(`Uploaded to ${url}\n`);
    } catch (error) {
      uploadFailed = true;
      io.stderr.write(
        `${c.red('✖ Upload failed:')} ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
  }
  if (uploadFailed) return EXIT_ERROR;

  let failed = false;
  if (options.failOn && exceedsThreshold(result.findings, options.failOn)) {
    if (options.format !== 'table' || toFile) {
      io.stderr.write(`Found vulnerabilities at or above "${options.failOn}" (--fail-on)\n`);
    }
    failed = true;
  }
  if (options.failOnKev && hasKev) {
    io.stderr.write('Found known exploited vulnerabilities (--fail-on-kev)\n');
    failed = true;
  }
  return failed ? EXIT_FINDINGS : EXIT_OK;
}

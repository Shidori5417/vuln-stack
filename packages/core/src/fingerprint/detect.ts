import pLimit from 'p-limit';
import type { Confidence, Dependency, DetectedTechnology, Warning } from '../model/types.js';
import type { FetchFn } from '../net/context.js';
import { safeFetch, type Resolver, type SafeResponse } from '../net/ssrf.js';
import { VERSION } from '../version.js';
import {
  BUILTIN_SIGNATURES,
  CDN_ALIASES,
  KNOWN_NPM,
  matchContent,
  matchUrl,
  type Signature,
} from './signatures.js';

export interface Detected extends DetectedTechnology {
  /** npm package, when the technology is a dependency we can look up. */
  npm?: string;
}

export interface FingerprintOptions {
  fetch?: FetchFn;
  resolve: Resolver;
  /** Max script/style files fetched besides the page itself (default 20). */
  maxAssets?: number;
  maxAssetBytes?: number;
  maxPageBytes?: number;
  /** Total time budget for the whole fingerprint run (default 30 s). */
  timeBudgetMs?: number;
  userAgent?: string;
  signal?: AbortSignal;
  /** Extra signatures, e.g. from `loadRetireSignatures`. */
  signatures?: readonly Signature[];
}

export interface FingerprintResult {
  url: string;
  finalUrl: string;
  technologies: Detected[];
  dependencies: Dependency[];
  warnings: Warning[];
}

const CDN_HOSTS = new Set([
  'cdnjs.cloudflare.com',
  'cdn.jsdelivr.net',
  'unpkg.com',
  'code.jquery.com',
  'ajax.googleapis.com',
  'stackpath.bootstrapcdn.com',
]);

const CONFIDENCE_RANK: Record<Confidence, number> = { low: 0, medium: 1, high: 2 };
const STRICT_VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

function attr(tag: string, name: string): string | undefined {
  const re = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i');
  const m = re.exec(tag);
  return m ? (m[1] ?? m[2] ?? m[3]) : undefined;
}

function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'");
}

/** Very rough registrable domain; good enough to tell "own subdomain" from "other site". */
function siteOf(host: string): string {
  const labels = host.split('.');
  if (labels.length <= 2) return host;
  const secondLevel = labels.at(-2)!;
  const tld = labels.at(-1)!;
  const take = tld.length === 2 && secondLevel.length <= 3 ? 3 : 2;
  return labels.slice(-take).join('.');
}

function cdnPackage(url: URL): { npm: string; version: string } | undefined {
  if (!CDN_HOSTS.has(url.hostname)) return undefined;
  const path = decodeURIComponent(url.pathname);
  let name: string | undefined;
  let version: string | undefined;

  const npmStyle =
    url.hostname === 'cdn.jsdelivr.net'
      ? /^\/npm\/((?:@[^/@]+\/)?[^/@]+)@([^/]+)\//.exec(path)
      : url.hostname === 'unpkg.com'
        ? /^\/((?:@[^/@]+\/)?[^/@]+)@([^/]+)\//.exec(path)
        : null;
  if (npmStyle) {
    [, name, version] = npmStyle;
  } else {
    const libs = /^\/ajax\/libs\/([^/]+)\/([^/]+)\//.exec(path);
    if (libs) {
      const lower = libs[1]!.toLowerCase();
      name = CDN_ALIASES[lower] ?? (KNOWN_NPM.has(lower) ? lower : undefined);
      version = libs[2];
    } else if (url.hostname === 'stackpath.bootstrapcdn.com') {
      const bs = /^\/bootstrap\/([^/]+)\//.exec(path);
      if (bs) [name, version] = ['bootstrap', bs[1]];
    }
  }
  return name && version && STRICT_VERSION.test(version) ? { npm: name, version } : undefined;
}

interface Tech {
  name: string;
  npm?: string;
  version?: string;
  source: string;
  confidence: Confidence;
}

const PRODUCTS: Record<string, { name: string; npm?: string }> = {
  nginx: { name: 'nginx' },
  apache: { name: 'Apache HTTP Server' },
  'microsoft-iis': { name: 'IIS' },
  php: { name: 'PHP' },
  express: { name: 'Express', npm: 'express' },
  'next.js': { name: 'Next.js', npm: 'next' },
  nuxt: { name: 'Nuxt', npm: 'nuxt' },
  'asp.net': { name: 'ASP.NET' },
};

function fromHeaderValue(value: string, source: string): Tech[] {
  const out: Tech[] = [];
  for (const m of value.matchAll(/([A-Za-z][A-Za-z0-9.+_-]*)(?:\/(\d[\w.+-]*))?/g)) {
    const product = PRODUCTS[m[1]!.toLowerCase()];
    if (!product) continue;
    out.push({
      ...product,
      ...(m[2] ? { version: m[2] } : {}),
      source,
      confidence: 'medium',
    });
  }
  return out;
}

const GENERATOR_NAMES: Record<string, string> = {
  wordpress: 'WordPress',
  drupal: 'Drupal',
  'joomla!': 'Joomla',
  joomla: 'Joomla',
};

function fromGenerator(value: string, source: string): Tech[] {
  const m = /^([A-Za-z][\w!.+ ]*?)(?:\s+v?(\d[\w.+-]*))?(?:\s+[-(].*)?$/.exec(value.trim());
  if (!m) return [];
  const name = GENERATOR_NAMES[m[1]!.toLowerCase()] ?? m[1]!.trim();
  return [{ name, ...(m[2] ? { version: m[2] } : {}), source, confidence: 'medium' }];
}

function headerTechs(headers: Headers): Tech[] {
  const out: Tech[] = [];
  const server = headers.get('server');
  if (server) out.push(...fromHeaderValue(server, 'headers'));
  const powered = headers.get('x-powered-by');
  if (powered) out.push(...fromHeaderValue(powered, 'headers'));
  const aspnet = headers.get('x-aspnet-version');
  if (aspnet)
    out.push({ name: 'ASP.NET', version: aspnet.trim(), source: 'headers', confidence: 'medium' });
  const mvc = headers.get('x-aspnetmvc-version');
  if (mvc)
    out.push({ name: 'ASP.NET MVC', version: mvc.trim(), source: 'headers', confidence: 'medium' });
  const generator = headers.get('x-generator');
  if (generator) out.push(...fromGenerator(generator, 'headers'));
  if (headers.has('x-drupal-cache') || headers.has('x-drupal-dynamic-cache')) {
    out.push({ name: 'Drupal', source: 'headers', confidence: 'medium' });
  }
  return out;
}

interface PageRefs {
  scripts: string[];
  styles: string[];
  generators: string[];
}

function parseHtml(html: string): PageRefs {
  const scripts: string[] = [];
  const styles: string[] = [];
  const generators: string[] = [];
  for (const m of html.matchAll(/<script\b[^>]*>/gi)) {
    const src = attr(m[0], 'src');
    if (src) scripts.push(decodeEntities(src));
  }
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    const rel = attr(m[0], 'rel')?.toLowerCase() ?? '';
    const href = attr(m[0], 'href');
    if (href && rel.split(/\s+/).includes('stylesheet')) styles.push(decodeEntities(href));
  }
  for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
    if (attr(m[0], 'name')?.toLowerCase() === 'generator') {
      const content = attr(m[0], 'content');
      if (content) generators.push(decodeEntities(content));
    }
  }
  return { scripts, styles, generators };
}

/** Passively fingerprints a website: one page request plus a few referenced assets. */
export async function fingerprintSite(
  url: string,
  options: FingerprintOptions,
): Promise<FingerprintResult> {
  const started = Date.now();
  const budget = options.timeBudgetMs ?? 30_000;
  const maxAssets = options.maxAssets ?? 20;
  const maxAssetBytes = options.maxAssetBytes ?? 2 * 1024 * 1024;
  const fetchFn: FetchFn = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const signatures = [...BUILTIN_SIGNATURES, ...(options.signatures ?? [])];
  const warnings: Warning[] = [];
  const techs: Tech[] = [];

  const get = (target: string, maxBytes: number, accept: string): Promise<SafeResponse> => {
    const remaining = budget - (Date.now() - started);
    return safeFetch(target, {
      fetch: fetchFn,
      resolve: options.resolve,
      maxBytes,
      timeoutMs: Math.max(1, Math.min(10_000, remaining)),
      headers: {
        accept,
        'user-agent': options.userAgent ?? `vulnstack/${VERSION} (passive fingerprint)`,
      },
      ...(options.signal ? { signal: options.signal } : {}),
    });
  };

  const page = await get(url, options.maxPageBytes ?? 5 * 1024 * 1024, 'text/html,*/*;q=0.8');
  if (!page.ok) {
    warnings.push({ code: 'page-status', message: `The page answered with HTTP ${page.status}` });
  }
  const finalUrl = new URL(page.url);
  techs.push(...headerTechs(page.headers));

  const refs = parseHtml(page.text);
  for (const g of refs.generators) techs.push(...fromGenerator(g, 'meta'));

  // Only same-site and well-known CDN assets are looked at.
  const pageSite = siteOf(finalUrl.hostname);
  const assetUrls: URL[] = [];
  const seen = new Set<string>();
  for (const ref of [...refs.scripts, ...refs.styles]) {
    let asset: URL;
    try {
      asset = new URL(ref, finalUrl);
    } catch {
      continue;
    }
    if (asset.protocol !== 'http:' && asset.protocol !== 'https:') continue;
    if (!CDN_HOSTS.has(asset.hostname) && siteOf(asset.hostname) !== pageSite) continue;
    asset.hash = '';
    if (seen.has(asset.href)) continue;
    seen.add(asset.href);
    assetUrls.push(asset);
  }

  const needContent: URL[] = [];
  const unresolved: URL[] = [];
  for (const asset of assetUrls) {
    const href = asset.href;
    if (/\/_next\//.test(asset.pathname)) {
      techs.push({ name: 'Next.js', npm: 'next', source: href, confidence: 'low' });
    } else if (/\/_nuxt\//.test(asset.pathname)) {
      techs.push({ name: 'Nuxt', npm: 'nuxt', source: href, confidence: 'low' });
    }
    const cdn = cdnPackage(asset);
    const matches = matchUrl(signatures, href);
    if (cdn && !matches.some((m) => m.npm === cdn.npm && m.version === cdn.version)) {
      matches.push({ component: cdn.npm, npm: cdn.npm, version: cdn.version, via: 'uri' });
    }
    for (const m of matches) {
      techs.push({
        name: m.component,
        npm: m.npm,
        version: m.version,
        source: href,
        confidence: 'medium',
      });
    }
    if (matches.length === 0) needContent.push(asset);
  }

  if (needContent.length > maxAssets) {
    warnings.push({
      code: 'asset-limit',
      message: `Only ${maxAssets} of ${needContent.length} assets were inspected`,
    });
  }
  const limit = pLimit(4);
  let budgetWarned = false;
  await Promise.all(
    needContent.slice(0, maxAssets).map((asset) =>
      limit(async () => {
        if (options.signal?.aborted) return;
        if (Date.now() - started >= budget) {
          if (!budgetWarned) {
            budgetWarned = true;
            warnings.push({
              code: 'time-budget',
              message: 'Time budget exhausted; assets skipped',
            });
          }
          return;
        }
        try {
          const res = await get(asset.href, maxAssetBytes, '*/*');
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const found = matchContent(signatures, res.text);
          for (const m of found) {
            techs.push({
              name: m.component,
              npm: m.npm,
              version: m.version,
              source: asset.href,
              confidence: 'medium',
            });
          }
          if (found.length === 0) unresolved.push(asset);
        } catch (error) {
          warnings.push({
            code: 'asset-failed',
            message: `Could not inspect ${asset.href}: ${(error as Error).message}`,
            file: asset.href,
          });
        }
      }),
    ),
  );

  // Heuristics (low confidence): `?ver=` on a file named after a known library, WordPress core assets.
  for (const asset of unresolved) {
    const ver = asset.searchParams.get('ver') ?? asset.searchParams.get('v');
    if (!ver || !STRICT_VERSION.test(ver)) continue;
    const base = (asset.pathname.split('/').pop() ?? '')
      .replace(/(\.min)?\.(js|css)$/i, '')
      .toLowerCase();
    const sig = signatures.find(
      (s) => s.origin === 'builtin' && s.npm === (CDN_ALIASES[base] ?? base),
    );
    if (sig) {
      techs.push({
        name: sig.component,
        npm: sig.npm,
        version: ver,
        source: asset.href,
        confidence: 'low',
      });
    } else if (asset.pathname.startsWith('/wp-includes/')) {
      techs.push({ name: 'WordPress', version: ver, source: asset.href, confidence: 'low' });
    }
  }
  if (assetUrls.some((a) => a.pathname.includes('/wp-content/'))) {
    techs.push({ name: 'WordPress', source: finalUrl.href, confidence: 'low' });
  }

  // Dedupe by name@version, keeping the most confident observation.
  const merged = new Map<string, Detected>();
  for (const t of techs) {
    const key = `${t.name}@${t.version ?? ''}`;
    const existing = merged.get(key);
    if (!existing || CONFIDENCE_RANK[t.confidence] > CONFIDENCE_RANK[existing.confidence]) {
      merged.set(key, {
        name: t.name,
        ...(t.version ? { version: t.version } : {}),
        source: t.source,
        confidence: t.confidence,
        ...(t.npm ? { npm: t.npm } : {}),
      });
    }
  }
  // An unversioned mention is redundant once a versioned one exists.
  const technologies = [...merged.values()].filter(
    (t) => t.version || ![...merged.values()].some((o) => o.name === t.name && o.version),
  );

  const deps = new Map<string, Dependency>();
  for (const t of technologies) {
    if (!t.npm || !t.version || !STRICT_VERSION.test(t.version)) continue;
    const key = `${t.npm}@${t.version}`;
    const existing = deps.get(key);
    if (existing && CONFIDENCE_RANK[existing.confidence] >= CONFIDENCE_RANK[t.confidence]) continue;
    deps.set(key, {
      ecosystem: 'npm',
      name: t.npm,
      version: t.version,
      isDirect: true,
      sourceFile: t.source,
      confidence: t.confidence,
    });
  }

  return {
    url,
    finalUrl: finalUrl.href,
    technologies,
    dependencies: [...deps.values()],
    warnings,
  };
}

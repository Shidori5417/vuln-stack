/**
 * Small MIT-licensed signature set for common JavaScript libraries.
 * Patterns use the retire.js convention so both sources share one engine: the
 * placeholder `§§version§§` is replaced by a lazy version matcher and the
 * version is capture group 1.
 */
export interface Signature {
  /** Display name. */
  component: string;
  /** npm package the library is published as. */
  npm: string;
  origin: 'builtin' | 'retire';
  /** Matched against the full asset URL. */
  uri?: string[];
  /** Matched against the last path segment of the URL. */
  filename?: string[];
  /** Matched against the asset body. */
  filecontent?: string[];
}

export interface SignatureMatch {
  component: string;
  npm: string;
  version: string;
  via: 'uri' | 'filename' | 'filecontent';
}

const PLACEHOLDER = '§§version§§';
const VERSION_RE = '[0-9][0-9a-z._+-]*?';
const compiled = new Map<string, RegExp | null>();

/** Compiles an extractor pattern; returns undefined when it is not a valid regex. */
export function compileExtractor(pattern: string, flags: string): RegExp | undefined {
  const key = `${flags}/${pattern}`;
  let re = compiled.get(key);
  if (re === undefined) {
    try {
      re = new RegExp(pattern.split(PLACEHOLDER).join(VERSION_RE), flags);
    } catch {
      re = null;
    }
    compiled.set(key, re);
  }
  return re ?? undefined;
}

const SANE_VERSION = /^\d+(?:\.\d+)*(?:[-+.]?[0-9a-z][0-9a-z.+-]*)?$/i;

export function cleanVersion(raw: string): string | undefined {
  const version = raw.replace(/[._+-]+$/, '');
  return version.length <= 40 && SANE_VERSION.test(version) ? version : undefined;
}

function firstVersion(patterns: string[] | undefined, text: string, flags: string) {
  for (const pattern of patterns ?? []) {
    const match = compileExtractor(pattern, flags)?.exec(text);
    const version = match?.[1] ? cleanVersion(match[1]) : undefined;
    if (version) return version;
  }
  return undefined;
}

/** Applies URL-based extractors of every signature. */
export function matchUrl(signatures: readonly Signature[], url: string): SignatureMatch[] {
  const filename = decodeURIComponent(url.split(/[?#]/)[0]!.split('/').pop() ?? '').trim();
  const out: SignatureMatch[] = [];
  for (const sig of signatures) {
    const byUri = firstVersion(sig.uri, url, 'i');
    const byName = byUri ? undefined : firstVersion(sig.filename, filename, 'i');
    const version = byUri ?? byName;
    if (version) {
      out.push({
        component: sig.component,
        npm: sig.npm,
        version,
        via: byUri ? 'uri' : 'filename',
      });
    }
  }
  return out;
}

/** Content extractors of untrusted (retire) signatures only run on bodies up to this size. */
export const RETIRE_CONTENT_LIMIT = 512 * 1024;

export function matchContent(signatures: readonly Signature[], content: string): SignatureMatch[] {
  const out: SignatureMatch[] = [];
  for (const sig of signatures) {
    if (sig.origin === 'retire' && content.length > RETIRE_CONTENT_LIMIT) continue;
    const version = firstVersion(sig.filecontent, content, '');
    if (version) {
      out.push({ component: sig.component, npm: sig.npm, version, via: 'filecontent' });
    }
  }
  return out;
}

// Version followed by something that cannot continue a version number.
const V = String.raw`(§§version§§)(?![0-9A-Za-z_+-]|\.[0-9])`;

const sig = (
  component: string,
  npm: string,
  parts: Pick<Signature, 'uri' | 'filename' | 'filecontent'>,
): Signature => ({ component, npm, origin: 'builtin', ...parts });

export const BUILTIN_SIGNATURES: readonly Signature[] = [
  sig('jQuery', 'jquery', {
    uri: [
      String.raw`/jquery[-.]${V}(?:\.slim)?(?:\.min)?\.js`,
      String.raw`/jquery/${V}/`,
      String.raw`/jquery@${V}/`,
    ],
    filecontent: [
      String.raw`jQuery JavaScript Library v${V}`,
      String.raw`/\*!? jQuery v${V}`,
      String.raw`fn\.jquery\s*=\s*"${V}"`,
      String.raw`jquery:\s*"${V}",constructor`,
    ],
  }),
  sig('jQuery UI', 'jquery-ui', {
    uri: [String.raw`/ui/${V}/jquery-ui`, String.raw`/jquery-ui[-.]${V}(?:\.min)?\.js`],
    filecontent: [String.raw`jQuery UI - v${V}`],
  }),
  sig('jQuery Migrate', 'jquery-migrate', {
    uri: [String.raw`/jquery-migrate[-.]${V}(?:\.min)?\.js`],
    filecontent: [String.raw`jQuery Migrate v${V}`],
  }),
  sig('Bootstrap', 'bootstrap', {
    uri: [
      String.raw`/bootstrap/${V}/`,
      String.raw`/bootstrap[-.]${V}(?:\.bundle)?(?:\.min)?\.(?:js|css)`,
    ],
    filecontent: [String.raw`Bootstrap v${V}`],
  }),
  sig('Lodash', 'lodash', {
    uri: [String.raw`/lodash(?:\.js)?[-.@/]${V}`],
    filecontent: [String.raw`\* lodash v?${V}`, String.raw`@license\s+lodash v?${V}`],
  }),
  sig('Underscore.js', 'underscore', {
    uri: [String.raw`/underscore[-.]${V}(?:\.min)?\.js`],
    filecontent: [String.raw`Underscore\.js ${V}`],
  }),
  sig('Moment.js', 'moment', {
    uri: [String.raw`/moment[-.]${V}(?:\.min)?\.js`],
    filecontent: [String.raw`//! moment\.js\s*\n//! version : ${V}`],
  }),
  sig('AngularJS', 'angular', {
    uri: [String.raw`/angular(?:\.js)?[-.]${V}(?:\.min)?\.js`],
    filecontent: [String.raw`AngularJS v${V}`],
  }),
  sig('React', 'react', {
    filecontent: [String.raw`@license React v${V}[\s*]*react\.(?:production|development)`],
  }),
  sig('React DOM', 'react-dom', {
    filecontent: [String.raw`@license React v${V}[\s*]*react-dom\.(?:production|development)`],
  }),
  sig('Vue.js', 'vue', {
    uri: [String.raw`/vue[-.]${V}(?:\.runtime)?(?:\.min)?\.js`],
    filecontent: [String.raw`Vue\.js v${V}`],
  }),
  sig('Handlebars', 'handlebars', {
    uri: [String.raw`/handlebars[-.]v?${V}(?:\.runtime)?(?:\.min)?\.js`],
    filecontent: [String.raw`handlebars v${V}`, String.raw`Handlebars\.VERSION = "${V}"`],
  }),
  sig('DOMPurify', 'dompurify', {
    filecontent: [String.raw`@license DOMPurify ${V}`, String.raw`DOMPurify\.version = '${V}'`],
  }),
  sig('Axios', 'axios', {
    filecontent: [String.raw`(?:/\*|//) [Aa]xios v${V}`],
  }),
  sig('Knockout', 'knockout', {
    uri: [String.raw`/knockout[-.]${V}(?:\.min)?\.js`],
    filecontent: [String.raw`Knockout JavaScript library v${V}`],
  }),
  sig('Backbone.js', 'backbone', {
    filecontent: [String.raw`Backbone\.js ${V}`],
  }),
  sig('Swiper', 'swiper', {
    filecontent: [String.raw`\* Swiper ${V}`],
  }),
  sig('Select2', 'select2', {
    uri: [String.raw`/select2/${V}/`],
    filecontent: [String.raw`Select2 ${V}`],
  }),
  sig('Chart.js', 'chart.js', {
    filecontent: [String.raw`Chart\.js v${V}`, String.raw`chartjs\.org/\s*\*?\s*Version: ${V}`],
  }),
  sig('D3', 'd3', {
    filecontent: [String.raw`https://d3js\.org v${V}`],
  }),
];

/** Package names that signatures (and thus CDN path heuristics) are allowed to report. */
export const KNOWN_NPM = new Set(BUILTIN_SIGNATURES.map((s) => s.npm));

/** Library names used by CDNs (cdnjs / Google Hosted Libraries) that differ from the npm name. */
export const CDN_ALIASES: Record<string, string> = {
  'angular.js': 'angular',
  angularjs: 'angular',
  'twitter-bootstrap': 'bootstrap',
  jqueryui: 'jquery-ui',
  'lodash.js': 'lodash',
  'underscore.js': 'underscore',
  'moment.js': 'moment',
  'handlebars.js': 'handlebars',
  'backbone.js': 'backbone',
  'vue.js': 'vue',
  'chart.js': 'chart.js',
  d3: 'd3',
  knockout: 'knockout',
  dompurify: 'dompurify',
  axios: 'axios',
  select2: 'select2',
  swiper: 'swiper',
};

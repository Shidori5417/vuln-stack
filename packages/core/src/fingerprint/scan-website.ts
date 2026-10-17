import { addEdge, addNode, createGraph, ROOT_ID } from '../model/graph.js';
import type { ScanResult, Subproject, Warning } from '../model/types.js';
import type { Resolver } from '../net/ssrf.js';
import { scanSubprojects, type ScanOptions } from '../scan.js';
import { fingerprintSite } from './detect.js';
import { loadRetireSignatures } from './retire.js';
import type { Signature } from './signatures.js';

export interface WebsiteScanOptions extends ScanOptions {
  /** DNS resolver for SSRF checks (`nodeResolve` from `@vulnstack/core/node`). */
  resolve: Resolver;
  maxAssets?: number;
  /** Also use retire.js signatures (downloads them once per day). */
  retire?: boolean;
}

/** Fingerprints a website passively and scans the detected JavaScript libraries. */
export async function scanWebsite(url: string, options: WebsiteScanOptions): Promise<ScanResult> {
  const fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const warnings: Warning[] = [];
  let signatures: Signature[] = [];
  if (options.retire) {
    try {
      signatures = await loadRetireSignatures(fetch, options.cache);
    } catch (error) {
      warnings.push({
        code: 'retire-failed',
        message: `retire.js signatures unavailable: ${(error as Error).message}`,
      });
    }
  }

  options.onProgress?.('parse');
  const fp = await fingerprintSite(url, {
    fetch,
    resolve: options.resolve,
    signatures,
    ...(options.maxAssets !== undefined ? { maxAssets: options.maxAssets } : {}),
    ...(options.userAgent ? { userAgent: options.userAgent } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  });
  warnings.push(...fp.warnings);

  const host = new URL(fp.finalUrl).hostname;
  const subprojects: Subproject[] = [];
  if (fp.dependencies.length > 0) {
    const graph = createGraph(host);
    for (const dep of fp.dependencies) addEdge(graph, ROOT_ID, addNode(graph, dep));
    subprojects.push({ path: host, ecosystem: 'npm', graph, warnings: [] });
  } else {
    warnings.push({
      code: 'no-libraries',
      message: 'No versioned JavaScript libraries were detected on the page',
    });
  }

  const result = await scanSubprojects(subprojects, options, warnings);
  result.detected = fp.technologies.map(({ npm: _npm, ...rest }) => rest);
  return result;
}

import type { ScanResult } from '../model/types.js';

/**
 * Machine-readable report. `DependencyGraph` uses Maps, so subprojects are
 * flattened into plain arrays; findings already reference their dependency.
 */
export interface JsonReport extends Omit<ScanResult, 'subprojects'> {
  subprojects: {
    path: string;
    ecosystem: string;
    root: string;
    dependencies: ScanResult['subprojects'][number]['graph']['nodes'] extends Map<string, infer D>
      ? D[]
      : never;
    warnings: ScanResult['warnings'];
  }[];
}

export function toJsonReport(result: ScanResult): JsonReport {
  return {
    ...result,
    subprojects: result.subprojects.map((s) => ({
      path: s.path,
      ecosystem: s.ecosystem,
      root: s.graph.root,
      dependencies: [...s.graph.nodes.values()],
      warnings: s.warnings,
    })),
  };
}

export function formatJson(result: ScanResult): string {
  return `${JSON.stringify(toJsonReport(result), null, 2)}\n`;
}

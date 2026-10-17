import Table from 'cli-table3';
import type { Finding, ScanResult, SeverityCounts } from '@vulnstack/core';
import { SEVERITY_ORDER } from '@vulnstack/core';
import { paintSeverity, type Colors } from './colors.js';

export interface TableOptions {
  colors: Colors;
  /** Terminal width; tables are sized to fit it. */
  width?: number;
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Shortens long chains in the middle: `app > a > … > y > z`. */
export function formatChain(chain: string[], max = 4): string {
  if (chain.length <= max) return chain.join(' > ');
  return [...chain.slice(0, 2), '…', ...chain.slice(-(max - 2))].join(' > ');
}

function truncate(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

export function formatCounts(counts: SeverityCounts, c: Colors): string {
  return SEVERITY_ORDER.filter((s) => counts[s] > 0)
    .map((s) => paintSeverity(c, s, `${counts[s]} ${s}`))
    .join(', ');
}

function fixCell(f: Finding, c: Colors): string {
  const { type, fixedVersion } = f.remediation;
  if (type === 'no-fix' || !fixedVersion) return c.red('no fix yet');
  return type === 'safe-patch'
    ? `${c.green(fixedVersion)}\n${c.dim('safe patch')}`
    : `${c.yellow(fixedVersion)}\n${c.yellow('breaking update')}`;
}

function packageCell(f: Finding, c: Colors): string {
  const d = f.dependency;
  const tags = [d.isDirect ? 'direct' : 'transitive'];
  if (d.scope === 'dev') tags.push('dev');
  if (d.confidence !== 'high') tags.push('estimated version');
  return `${c.bold(d.name)} ${d.version}\n${c.dim(tags.join(', '))}`;
}

function vulnCell(f: Finding, c: Colors, width: number): string {
  const v = f.vulnerability;
  const others = v.aliases.filter((a) => a !== v.id);
  const lines = [c.bold(v.id)];
  if (others.length) lines.push(c.dim(truncate(others.join(', '), width)));
  if (v.summary) lines.push(truncate(v.summary, width * 2));
  return lines.join('\n');
}

function severityCell(f: Finding, c: Colors): string {
  const v = f.vulnerability;
  const label = paintSeverity(c, v.severity, v.severity.toUpperCase());
  return v.cvss ? `${label}\n${c.dim(v.cvss.score.toFixed(1))}` : label;
}

export function renderFindingsTable(findings: Finding[], options: TableOptions): string {
  const c = options.colors;
  const width = Math.max(80, options.width ?? 120);
  // Fixed columns, the rest is split between vulnerability and path. 16 = borders + padding.
  const sev = 10;
  const pkg = 26;
  const fix = 17;
  const flexible = width - sev - pkg - fix - 16;
  const vuln = Math.max(24, Math.floor(flexible * 0.6));
  const path = Math.max(16, flexible - vuln);

  const table = new Table({
    head: ['Severity', 'Package', 'Vulnerability', 'Fix', 'Path'].map((h) => c.bold(h)),
    colWidths: [sev, pkg, vuln, fix, path],
    wordWrap: true,
    style: { head: [], border: [] },
  });

  for (const f of findings) {
    const chain = f.dependency.isDirect ? c.dim('direct') : formatChain(f.chain);
    const paths =
      f.pathCount > 1
        ? `\n${c.dim(`+${f.pathCount - 1} more path${f.pathCount > 2 ? 's' : ''}`)}`
        : '';
    table.push([
      severityCell(f, c),
      packageCell(f, c),
      vulnCell(f, c, vuln - 2),
      fixCell(f, c),
      chain + paths,
    ]);
  }
  return table.toString();
}

export function renderDetected(result: ScanResult, c: Colors): string[] {
  const detected = result.detected ?? [];
  if (detected.length === 0) return [];
  const lines = [c.bold('Detected technologies')];
  for (const d of detected) {
    lines.push(`  ${d.name} ${d.version ?? c.dim('unknown version')} ${c.dim(`(${d.source})`)}`);
  }
  lines.push('');
  return lines;
}

export function renderReport(result: ScanResult, options: TableOptions): string {
  const c = options.colors;
  const out: string[] = [];
  const { summary } = result;
  const seconds = (result.durationMs / 1000).toFixed(1);
  out.push(
    c.dim(
      `vulnstack ${result.tool.version} · ${plural(summary.subprojects, 'project')} · ` +
        `${plural(summary.dependencies, 'dependency', 'dependencies')} · ${seconds}s`,
    ),
  );
  out.push('');
  out.push(...renderDetected(result, c));

  const ignored = result.ignored?.length ?? 0;
  const ignoredNote = ignored
    ? c.dim(`${plural(ignored, 'finding')} ignored by your ignore rules.`)
    : '';

  if (summary.findings === 0) {
    out.push(
      c.green(
        c.bold(
          `✔ No known vulnerabilities found in ${plural(summary.dependencies, 'dependency', 'dependencies')}.`,
        ),
      ),
    );
    if (ignoredNote) out.push(ignoredNote);
    return `${out.join('\n')}\n`;
  }

  const bySub = new Map<string, Finding[]>();
  for (const f of result.findings) {
    const list = bySub.get(f.subproject) ?? [];
    list.push(f);
    bySub.set(f.subproject, list);
  }
  for (const sub of result.subprojects) {
    const findings = bySub.get(sub.path);
    if (!findings) continue;
    const source = findings[0]!.dependency.sourceFile;
    out.push(`${c.bold(sub.graph.root)} ${c.dim(`(${source})`)}`);
    out.push(renderFindingsTable(findings, options));
    out.push('');
  }

  out.push(
    `${c.bold(`✖ ${plural(summary.findings, 'vulnerability', 'vulnerabilities')}`)} ` +
      `(${formatCounts(summary.bySeverity, c)}) in ${summary.vulnerableDependencies} of ` +
      `${plural(summary.dependencies, 'dependency', 'dependencies')}.`,
  );
  const safe = result.findings.filter((f) => f.remediation.type === 'safe-patch').length;
  if (safe > 0) out.push(c.dim(`${safe} can be fixed without a major version upgrade.`));
  if (ignoredNote) out.push(ignoredNote);
  return `${out.join('\n')}\n`;
}

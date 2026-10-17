import { resolve } from 'node:path';
import { ECOSYSTEMS, type Ecosystem } from '@vulnstack/core';
import {
  defaultOfflineDir,
  readExploitMeta,
  readOfflineMeta,
  updateExploitData,
  updateOfflineDatabase,
} from '@vulnstack/core/node';
import { EXIT_ERROR, EXIT_OK, type CliIO } from '../io.js';
import { createFetch } from '../net.js';
import { colorsFor } from '../render/colors.js';

export interface DbOptions {
  ecosystem?: string[];
  dir?: string;
  /** Commander `--no-exploit`: false skips KEV / EPSS. */
  exploit?: boolean;
}

/** Offline data older than this triggers a warning. */
export const STALE_DAYS = 7;

/** KEV changes daily and EPSS is published daily, so they go stale sooner than OSV dumps. */
export const EXPLOIT_STALE_DAYS = 3;

export const offlineDir = (dir: string | undefined, cwd: string) =>
  dir ? resolve(cwd, dir) : defaultOfflineDir();

/** Case-insensitive ecosystem names; values may be comma separated. */
export function parseEcosystems(values: string[] | undefined): Ecosystem[] {
  if (!values?.length) return [...ECOSYSTEMS];
  return values
    .flatMap((v) => v.split(','))
    .map((v) => v.trim())
    .filter(Boolean)
    .map((v) => {
      const eco = ECOSYSTEMS.find((e) => e.toLowerCase() === v.toLowerCase());
      if (!eco) throw new Error(`Unknown ecosystem "${v}" (expected: ${ECOSYSTEMS.join(', ')})`);
      return eco;
    });
}

const mb = (bytes: number) => `${(bytes / 1024 ** 2).toFixed(1)} MB`;

export async function runDbUpdate(options: DbOptions, io: CliIO): Promise<number> {
  const c = colorsFor(io.stderr, io.env);
  let ecosystems: Ecosystem[];
  try {
    ecosystems = parseEcosystems(options.ecosystem);
  } catch (error) {
    io.stderr.write(`${c.red('✖')} ${(error as Error).message}\n`);
    return EXIT_ERROR;
  }
  const fetch = io.fetch ?? createFetch(io.env);
  const started = Date.now();
  const dir = offlineDir(options.dir, io.cwd);
  const say = (message: string) => io.stderr.write(`${message}\n`);
  const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

  let osvOk = true;
  io.stdout.write(`Offline database: ${dir}\n`);
  try {
    const result = await updateOfflineDatabase({
      ecosystems,
      dir,
      ...(fetch ? { fetch } : {}),
      onProgress: say,
    });
    let total = 0;
    for (const eco of ecosystems) {
      const entry = result.updated[eco];
      if (entry) {
        total += entry.bytes;
        io.stdout.write(
          `  ${eco.padEnd(10)} ${String(entry.records).padStart(8)} records  ${mb(entry.bytes)}\n`,
        );
      } else {
        io.stdout.write(`  ${eco.padEnd(10)} unchanged\n`);
      }
    }
    io.stdout.write(
      `Done in ${((Date.now() - started) / 1000).toFixed(1)} s, ${mb(total)} written.\n`,
    );
  } catch (error) {
    osvOk = false;
    io.stderr.write(`${c.red('✖ OSV update failed:')} ${message(error)}\n`);
  }

  if (options.exploit === false) return osvOk ? EXIT_OK : EXIT_ERROR;

  let exploitOk = true;
  try {
    const result = await updateExploitData({
      dir,
      ...(fetch ? { fetch } : {}),
      onProgress: say,
    });
    for (const name of ['kev', 'epss'] as const) {
      const entry = result.updated[name];
      io.stdout.write(
        entry
          ? `  ${name.toUpperCase().padEnd(10)} ${String(entry.records).padStart(8)} records  ${mb(entry.bytes)}\n`
          : `  ${name.toUpperCase().padEnd(10)} unchanged\n`,
      );
    }
  } catch (error) {
    exploitOk = false;
    io.stderr.write(
      `${c.red('✖ KEV/EPSS update failed:')} ${message(error)} (existing local data, if any, is kept)\n`,
    );
  }
  // Fail only when nothing at all could be updated.
  return osvOk || exploitOk ? EXIT_OK : EXIT_ERROR;
}

export async function runDbStatus(options: DbOptions, io: CliIO): Promise<number> {
  const dir = offlineDir(options.dir, io.cwd);
  const meta = await readOfflineMeta(dir);
  const c = colorsFor(io.stdout, io.env);
  io.stdout.write(`Offline database: ${dir}\n`);
  const now = Date.now();
  let stale = false;
  let any = false;
  for (const eco of ECOSYSTEMS) {
    const entry = meta[eco];
    if (!entry) {
      io.stdout.write(`  ${eco.padEnd(10)} not downloaded\n`);
      continue;
    }
    any = true;
    const age = Math.floor((now - Date.parse(entry.builtAt)) / 86_400_000);
    if (age > STALE_DAYS) stale = true;
    io.stdout.write(
      `  ${eco.padEnd(10)} built ${entry.builtAt} (${age} d ago)  ${entry.records} records  ${mb(entry.bytes)}\n`,
    );
  }
  const exploit = await readExploitMeta(dir);
  let exploitStale = false;
  let exploitMissing = false;
  for (const [key, label] of [
    ['kev', 'KEV'],
    ['epss', 'EPSS'],
  ] as const) {
    const entry = exploit[key];
    if (!entry) {
      exploitMissing = true;
      io.stdout.write(`  ${label.padEnd(10)} not downloaded\n`);
      continue;
    }
    const age = Math.floor((now - Date.parse(entry.builtAt)) / 86_400_000);
    if (age > EXPLOIT_STALE_DAYS) exploitStale = true;
    io.stdout.write(
      `  ${label.padEnd(10)} built ${entry.builtAt} (${age} d ago)  ${entry.records} records  ${mb(entry.bytes)}\n`,
    );
  }
  if (exploitStale)
    io.stdout.write(
      `${c.yellow('⚠')} KEV/EPSS data is older than ${EXPLOIT_STALE_DAYS} days. Run: vulnstack db update\n`,
    );
  else if (exploitMissing && any)
    io.stdout.write('KEV/EPSS data not downloaded. Run: vulnstack db update\n');
  if (!any) io.stdout.write('Nothing downloaded yet. Run: vulnstack db update\n');
  else if (stale)
    io.stdout.write(
      `${c.yellow('⚠')} Some data is older than ${STALE_DAYS} days. Run: vulnstack db update\n`,
    );
  return EXIT_OK;
}

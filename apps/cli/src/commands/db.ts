import { resolve } from 'node:path';
import { ECOSYSTEMS, type Ecosystem } from '@vulnstack/core';
import { defaultOfflineDir, readOfflineMeta, updateOfflineDatabase } from '@vulnstack/core/node';
import { EXIT_ERROR, EXIT_OK, type CliIO } from '../io.js';
import { createFetch } from '../net.js';
import { colorsFor } from '../render/colors.js';

export interface DbOptions {
  ecosystem?: string[];
  dir?: string;
}

/** Offline data older than this triggers a warning. */
export const STALE_DAYS = 7;

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
  const result = await updateOfflineDatabase({
    ecosystems,
    dir: offlineDir(options.dir, io.cwd),
    ...(fetch ? { fetch } : {}),
    onProgress: (message) => io.stderr.write(`${message}\n`),
  });

  io.stdout.write(`Offline database: ${result.dir}\n`);
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
  return EXIT_OK;
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
  if (!any) io.stdout.write('Nothing downloaded yet. Run: vulnstack db update\n');
  else if (stale)
    io.stdout.write(
      `${c.yellow('⚠')} Some data is older than ${STALE_DAYS} days. Run: vulnstack db update\n`,
    );
  return EXIT_OK;
}

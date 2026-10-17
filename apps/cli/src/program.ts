import { Command, CommanderError, InvalidArgumentError, Option } from 'commander';
import { VERSION } from '@vulnstack/core';
import { FAIL_LEVELS } from '@vulnstack/core';
import { runDbStatus, runDbUpdate, type DbOptions } from './commands/db.js';
import { FORMATS, runScan, type ScanCommandOptions } from './commands/scan.js';
import { EXIT_ERROR, EXIT_OK, type CliIO } from './io.js';
import { colorsFor } from './render/colors.js';

export async function runCli(argv: string[], io: CliIO): Promise<number> {
  let exitCode = EXIT_OK;
  const program = new Command()
    .name('vulnstack')
    .description('Find known vulnerabilities (CVE / GHSA) in your dependencies')
    .version(VERSION, '-v, --version')
    .exitOverride()
    .configureOutput({
      writeOut: (s) => io.stdout.write(s),
      writeErr: (s) => io.stderr.write(s),
    });

  program
    .command('scan')
    .description('Scan a project folder (lock files preferred) or a manual package list')
    .argument('[path]', 'project folder to scan (default: .)')
    .option(
      '-m, --manual <packages>',
      'scan a list instead of files, e.g. "react@18.2.0,express@4.17.1"',
    )
    .option(
      '--repo <github-url|owner/repo>',
      'scan a GitHub repository without cloning (private repos: set GITHUB_TOKEN, GH_TOKEN or VULNSTACK_GITHUB_TOKEN)',
    )
    .option(
      '--url <site>',
      "passively fingerprint a website's JavaScript libraries (needs --i-own-this-site)",
    )
    .option(
      '--i-own-this-site',
      'confirm you may scan the --url site (or set VULNSTACK_URL_CONSENT=1)',
    )
    .option('--retire', 'with --url: also use retire.js signatures (downloaded once a day)')
    .addOption(
      new Option('-f, --format <format>', 'output format').choices(FORMATS).default('table'),
    )
    .option('-o, --output <file>', 'write the report to a file instead of stdout')
    .addOption(
      new Option(
        '--fail-on <severity>',
        'exit with code 1 when a finding is at or above this severity',
      ).choices(FAIL_LEVELS),
    )
    .option(
      '--ignore <ids>',
      'ignore vulnerabilities by id (CVE/GHSA/…); repeatable or comma separated',
      (value: string, previous: string[]) => [...previous, value],
      [] as string[],
    )
    .option(
      '--ignore-file <path>',
      'ignore rules file (default: .vulnstackignore in the scanned folder; not looked up for --repo/--url)',
    )
    .option('--upload', 'upload the JSON report to the VulnStack web app (needs VULNSTACK_TOKEN)')
    .option(
      '--project <name>',
      'project name for --upload (default: folder, repo or host name, or "manual")',
    )
    .option('--api-url <url>', 'web app base URL for --upload (default: $VULNSTACK_API_URL)')
    .option(
      '--offline',
      'scan against the local OSV database (see "vulnstack db update"); no network for advisories',
    )
    .option('--offline-dir <path>', 'offline database folder (default: <cache dir>/offline)')
    .option('--no-dev', 'skip dev dependencies')
    .option('--no-cache', 'do not read or write the local advisory cache')
    .option('--no-resolve', 'do not query package registries to resolve manifest ranges')
    .option(
      '--no-ghsa',
      'do not query the GitHub Advisory Database (used when GITHUB_TOKEN is set)',
    )
    .option(
      '--nvd',
      'enrich CVSS scores from NVD even without NVD_API_KEY (slow: 5 requests / 30 s)',
    )
    .option('--no-nvd', 'do not query NVD even when NVD_API_KEY is set')
    .addOption(
      new Option('--nvd-timeout <seconds>', 'time budget for NVD enrichment')
        .default(10)
        .argParser((v) => {
          const n = Number(v);
          if (!Number.isFinite(n) || n < 0)
            throw new InvalidArgumentError('must be a non-negative number');
          return n;
        }),
    )
    .action(async (path: string | undefined, options: ScanCommandOptions) => {
      exitCode = await runScan(path, options, io);
    });

  const db = program
    .command('db')
    .description('Manage the local OSV database used by "scan --offline"');
  db.command('update')
    .description('Download OSV dumps and build the offline database')
    .option(
      '--ecosystem <eco...>',
      'ecosystems to update (default: all of npm PyPI Packagist Maven Go NuGet)',
    )
    .option('--dir <path>', 'database folder (default: <cache dir>/offline)')
    .action(async (options: DbOptions) => {
      exitCode = await runDbUpdate(options, io);
    });
  db.command('status')
    .description('Show when each ecosystem was last updated')
    .option('--dir <path>', 'database folder (default: <cache dir>/offline)')
    .action(async (options: DbOptions) => {
      exitCode = await runDbStatus(options, io);
    });

  try {
    await program.parseAsync(argv, { from: 'user' });
    return exitCode;
  } catch (error) {
    if (error instanceof CommanderError) {
      // --help / --version exit through here with code 0
      return error.exitCode === 0 ? EXIT_OK : EXIT_ERROR;
    }
    const c = colorsFor(io.stderr, io.env);
    const message = error instanceof Error ? error.message : String(error);
    io.stderr.write(`${c.red('✖ Scan failed:')} ${message}\n`);
    if (io.env.DEBUG && error instanceof Error && error.stack) io.stderr.write(`${error.stack}\n`);
    return EXIT_ERROR;
  }
}

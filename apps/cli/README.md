# vulnstack

Find known vulnerabilities (CVE / GHSA) in your project's dependencies. Uses OSV, optionally GitHub Advisories and NVD.

## Install

```sh
npm install -g vulnstack   # or: npx vulnstack scan
```

Requires Node.js >= 22.12.

## Global install and direct commands

The package installs two bin names for the same file: `vulnstack` and `vulnscan`. Help text follows the name you invoked.

```sh
# From a checkout of the repository
pnpm build && cd apps/cli && pnpm link --global     # or from the root: pnpm cli:link

# With npm
cd apps/cli && npm link

# Once published
npx vulnstack scan
```

`pnpm link --global` needs pnpm's global bin directory on your `PATH`. Run `pnpm setup` once (it creates `~/.local/share/pnpm` on Linux and adds it to your shell profile), then open a new shell. Check with `which vulnscan`.

## Known exploited vulnerabilities (KEV) and EPSS

Online scans mark CVEs in CISA's Known Exploited Vulnerabilities catalog and add FIRST EPSS scores. The table gets an `Exploit` column (`KEV`, `ransomware`, `EPSS 12%`), KEV findings sort first inside each severity, and the summary ends with `N known exploited, highest EPSS x%`. JSON, SARIF and PDF reports carry the data from the core library.

- `--no-kev`, `--no-epss` turn the lookups off.
- `--kev-only` shows only known-exploited findings; `--min-epss <0-1|percent>` (`0.3`, `30`, `30%`) hides findings below that EPSS.
- `--fail-on-kev` exits 1 when a known-exploited finding remains after ignore rules (display filters do not hide it from this check).
- `--offline` reads the local copies; `vulnstack db update` downloads them (skip with `--no-exploit`) and `vulnstack db status` shows their age (stale after 3 days).

## Usage

```sh
vulnstack scan                         # scan current folder (lock files preferred)
vulnstack scan ./app --format json
vulnstack scan -m "react@18.2.0,express@4.17.1"
vulnstack scan --repo owner/repo       # no clone needed
vulnstack scan --format sarif --output vulnstack.sarif --fail-on high
```

## Options

- `-f, --format <table|json|sarif|pdf>` output format (default `table`)
- `-o, --output <file>` write report to a file
- `--fail-on <critical|high|medium|low|any>` exit 1 at or above this severity
- `--ignore <ids>`, `--ignore-file <path>` suppress findings (default file: `.vulnstackignore`)
- `--no-dev`, `--no-cache`, `--no-resolve`, `--no-ghsa`, `--nvd`, `--no-nvd`

- `--offline`, `--offline-dir <path>` scan against the local OSV database (see below)

Run `vulnstack scan --help` for the full list.

## Commands

- `vulnstack scan [path]` scan a folder, `--manual` list, `--repo` or `--url`
- `vulnstack db update [--ecosystem <eco...>] [--dir <path>]` download OSV dumps and build the offline database
- `vulnstack db status [--dir <path>]` show the offline database contents; warns if older than 7 days

## Offline mode

```sh
vulnstack db update                    # all eleven ecosystems (npm, PyPI, Packagist, Maven, Go, NuGet, RubyGems, crates.io, Hex, Pub, SwiftURL)
vulnstack db update --ecosystem npm,go # case-insensitive; space or comma separated
vulnstack scan --offline
```

- Uses `ETag` / `If-None-Match`, so unchanged dumps are not downloaded again.
- `scan --offline` makes no OSV, GHSA or NVD calls and skips registry range resolution, so lock files are needed for full coverage. It cannot be combined with `--url`.
- An ecosystem's index is loaded only when the scan queries it; a queried ecosystem that was never downloaded produces one warning.
- Default folder: `$XDG_CACHE_HOME/vulnstack/offline` (`~/.cache/vulnstack/offline`); override with `--dir` / `--offline-dir`.
- The npm dump is large (hundreds of MB download, about 1 GB of memory while indexing).

## Environment

- `GITHUB_TOKEN` (no scopes needed) enables GitHub Advisory Database lookups
- `NVD_API_KEY` enables fast CVSS enrichment from NVD

## Exit codes

- `0` scan finished, nothing at or above `--fail-on`
- `1` a finding at or above `--fail-on` was found
- `2` usage or runtime error

## CI

```yaml
- uses: Shidori5417/vuln-stack@v1
  with:
    fail-on: high
```

Or plain: `npx --yes vulnstack scan --fail-on high`.

MIT licensed.

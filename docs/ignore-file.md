# Ignore file

Use ignore rules to accept a known risk for a while without hiding it. Ignored findings leave `findings` and the exit-code check, but stay visible in the report under `ignored` (and as suppressed results in SARIF).

## Syntax

A file named `.vulnstackignore`, one rule per line:

```text
<id> [<package>] [until=YYYY-MM-DD]  # reason
```

```text
# Comment-only and blank lines are skipped
CVE-2021-23337                         # lodash template: we never pass user input to _.template
GHSA-35jh-r3h4-6jhm lodash until=2026-12-31  # waiting for the 5.x migration
cve-2022-0235 node-fetch               # package filter is case-insensitive too
```

| Part               | Meaning                                                                                 |
| ------------------ | --------------------------------------------------------------------------------------- |
| `<id>`             | Any identifier of the vulnerability: CVE, GHSA or another alias. Case-insensitive       |
| `<package>`        | Optional. Limits the rule to one package name (case-insensitive)                        |
| `until=YYYY-MM-DD` | Optional. The rule stops applying after that date (it still applies on the date itself) |
| `# reason`         | Everything after `#`. Strongly recommended                                              |

## Matching

A rule matches a finding when its `<id>` equals **any alias** of the vulnerability (VulnStack merges `CVE-…` and `GHSA-…` records, so either id works) and, if given, the package name equals the finding's package. The first matching rule wins.

## Warnings

| Code               | When                                                                       |
| ------------------ | -------------------------------------------------------------------------- |
| `ignore-no-reason` | A rule has no `# reason`; it still applies                                 |
| `ignore-syntax`    | An unexpected extra token on a line                                        |
| `ignore-expired`   | `until` is in the past; the rule no longer applies, so the finding is back |
| `ignore-unused`    | An active rule matched nothing; remove it so exceptions do not pile up     |

Warnings are printed to stderr and included in the report's `warnings`.

## Command line

| Option                 | Description                                                                                   |
| ---------------------- | --------------------------------------------------------------------------------------------- |
| `--ignore <ids>`       | Ignore ids without a file. Repeatable or comma separated: `--ignore CVE-2021-23337,GHSA-xxxx` |
| `--ignore-file <path>` | Use this file instead of `.vulnstackignore`. It must exist, otherwise the scan fails          |

Without `--ignore-file`, `.vulnstackignore` is read from the **scanned folder** if it exists. For `--manual` the current directory is used. For `--repo` and `--url` no file is looked up automatically; pass `--ignore-file` explicitly. Rules from `--ignore` and the file are combined. `--ignore` rules have no package filter, reason or expiry.

## Web triage vs the ignore file

|                     | Ignore file                                | Web app triage                                                |
| ------------------- | ------------------------------------------ | ------------------------------------------------------------- |
| Lives in            | Your repository, reviewed in pull requests | The web app database, per project                             |
| Applies to          | Every scan that reads the file (CLI, CI)   | Scans stored in that project (matched by finding fingerprint) |
| States              | Ignored (optionally until a date)          | `accepted` or `false_positive`, with a note                   |
| Affects `--fail-on` | Yes                                        | No: triage is a review aid in the UI                          |

Use the ignore file for decisions that should gate CI and be versioned with the code; use triage for team review of results in the web app.

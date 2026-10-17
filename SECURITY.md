# Security policy

## Reporting a vulnerability

Please report security issues **privately**. Do not open a public issue or pull request.

Use GitHub private vulnerability reporting: on the repository page open **Security**, then **Report a vulnerability**. Include what you found, how to reproduce it, the affected version or commit, and the impact you expect.

You can expect an acknowledgement within a few days and a status update as we investigate. We will credit reporters in the advisory unless you prefer to stay anonymous. Please give us reasonable time to ship a fix before disclosing publicly.

## Supported versions

Only the latest released version of the CLI (npm `vulnstack`) and the latest release of the web app image receive security fixes. Before 1.0, fixes land in the next patch or minor release.

## Scope

In scope:

- The CLI, `@vulnstack/core`, and the web app and its API (authentication, API tokens, access control between users, file upload handling, rate limiting).
- **The website scanner's SSRF protections** (`--url` and the web "Website" scan): bypasses of the blocked address ranges, redirect validation, DNS pinning or size / time limits are treated as high severity. See [docs/website-scanning.md](docs/website-scanning.md).
- Leaks of secrets (GitHub tokens, API tokens, session data).

Out of scope:

- **The `fixtures/` folder.** It intentionally contains lock files that pin known-vulnerable package versions, as test data. Reports about vulnerable versions in `fixtures/` are not valid, and the folder must never be installed.
- Findings that need a malicious local user with access to the machine running the CLI.
- Missing advisories or wrong severities in upstream data (OSV.dev, GitHub Advisory Database, NVD); report those to the source.
- Denial of service through clearly excessive request volume against an instance without rate limiting configured.

## Self-hosting hardening

Keep `BETTER_AUTH_SECRET` private and stable, serve the app over HTTPS, set `VULNSTACK_TRUST_PROXY=1` only behind a trusted proxy, and run the web app in a network that cannot reach internal services. See [docs/self-hosting.md](docs/self-hosting.md).

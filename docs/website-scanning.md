# Website scanning

`vulnstack scan --url https://example.com --i-own-this-site` (and the "Website" tab in the web app) identifies JavaScript libraries a site serves and checks their versions against the advisory databases. It is a fingerprint, not a penetration test.

## What it does

1. One `GET` of the page you gave.
2. Up to 20 public JS and CSS assets referenced by the page, limited to the **same site** or well-known CDNs (cdnjs, jsDelivr, unpkg, code.jquery.com, ajax.googleapis.com, stackpath.bootstrapcdn.com).
3. Reads response headers and `<meta>` tags that reveal technology and version (for example `Server`, `X-Powered-By`, `X-AspNet-Version`, `X-Generator`, `<meta name="generator">`).
4. Matches the content and URLs against built-in library signatures (and, with `--retire`, retire.js signatures) to get a library name and version, then looks the version up like any other dependency.

## What it does not do

- No crawling, no following links to other pages.
- No probing of paths, ports, parameters or login forms; no fuzzing, no payloads.
- No authentication, cookies or credentials are sent.
- No requests to private or internal addresses.
- No scan of server-side software beyond what response headers disclose.

## Consent

Scanning someone else's server without permission may be illegal. The CLI refuses to run `--url` unless you pass `--i-own-this-site` or set `VULNSTACK_URL_CONSENT=1`. The web app requires an explicit confirmation checkbox, and the API rejects requests without `consent: true`. Only scan sites you own or are authorised to test.

## SSRF protections

Because the server (or your machine) fetches a user-supplied URL, the fetcher is hardened:

| Protection                | Detail                                                                                                                                                                                                                                                                                                                      |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Scheme, port, credentials | Only `http` and `https`, ports 80 and 443 only, no `user:pass@` in URLs                                                                                                                                                                                                                                                     |
| Blocked names             | `localhost`, `*.local`, `*.internal`, `metadata`                                                                                                                                                                                                                                                                            |
| Blocked address ranges    | Loopback, private (10/8, 172.16/12, 192.168/16), link-local (169.254/16, includes cloud metadata), CGNAT (100.64/10), benchmarking, documentation and multicast/reserved ranges; for IPv6 loopback, unique-local (fc00::/7), link-local and IPv4-mapped, compatible, 6to4 and NAT64 forms that embed a blocked IPv4 address |
| Every resolved address    | A host is refused if **any** address it resolves to is non-public                                                                                                                                                                                                                                                           |
| Redirect re-validation    | Redirects are followed manually (at most 3); each hop is validated again                                                                                                                                                                                                                                                    |
| DNS pinning               | The CLI and the web app connect through a custom lookup that validates the addresses and connects to the exact address it validated, which defeats DNS rebinding                                                                                                                                                            |
| Size and time limits      | Page up to 5 MB, each asset up to 2 MB (streamed, aborted when exceeded), 10 s per request, overall time budget                                                                                                                                                                                                             |
| Rate limits (web app)     | Website scans get a third of the per-user scan budget                                                                                                                                                                                                                                                                       |

When embedding `@vulnstack/core` in your own server, inject a `fetch` with pinned lookup (see `apps/web/src/server/pinned-fetch.ts`); the core resolver check alone cannot prevent DNS rebinding.

## Confidence

| Level    | Typical source                                                                                            |
| -------- | --------------------------------------------------------------------------------------------------------- |
| `medium` | Version in a CDN URL (`/npm/jquery@3.4.1/…`), a banner comment or global in the file, a disclosing header |
| `low`    | Weak signals, such as a framework inferred from asset paths without a version                             |

Website results never reach `high`: a version string in a public file is not proof of what the server runs. Findings from a website scan show `Confidence: medium` or `low` in JSON and SARIF.

## retire.js signatures

`--retire` downloads the [retire.js](https://github.com/RetireJS/retire.js) signature repository (Apache-2.0) from GitHub, caches it for 24 hours and uses it in addition to the built-in signatures. If the download fails, the scan continues with a `retire-failed` warning. Entries without an npm package name are skipped, as they cannot be matched to an advisory.

## Limitations

- Client-side only: server frameworks, CMS plugins and back-end libraries are not covered unless a header reveals them.
- Bundled and minified code often hides library versions; expect false negatives.
- Libraries loaded by script after page load, behind logins or from other origins are not seen.
- A version found in a file is the version the file claims, which may differ from what is patched or backported.
- Single page apps that need JavaScript execution to reference assets are only seen through their static HTML.

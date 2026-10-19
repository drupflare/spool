# Security Policy

## Supported Versions

Spool is before 1.0. Security fixes go into the latest minor release only.

| Version | Supported |
| ------- | --------- |
| 0.1.x   | yes       |

A fix ships as a new patch version on npm and on `cdn.drupflare.com`. Release files on the CDN are
immutable, so a site that pins a version and its SRI hash keeps the old file until it moves to the
new version and hash. The release notes carry both.

## Reporting a Vulnerability

Do not open a public issue for a vulnerability. Report it privately through GitHub's
[private vulnerability reporting](https://github.com/drupflare/spool/security/advisories/new), or
by email to the maintainer at <me@gmitch215.xyz>.

Include the spool version, the server runtime, the browser and its version, the steps to reproduce,
and what an attacker gains. A failing test or a minimal page is the fastest way to a fix.

The maintainer confirms the report, works on a fix in private, and publishes a GitHub security
advisory with the patch release. Reporters are credited in the advisory unless they ask not to be.

## Scope

In scope:

- the `@drupflare/spool` package: the server half, the service worker, the page runtime, proxy
  mode and the stores
- the files published under `cdn.drupflare.com/spool/`
- the wire protocol in [docs/protocol.md](docs/protocol.md)

Out of scope:

- a site's own routes, templates, renderers and `load` functions, and what they choose to send
- third-party services a site loads, and analytics sinks
- a compromised server, a compromised browser, or malware that reads the device's disk

## How Spool Protects Data

The full threat model, with the code path and test behind each claim, is
[docs/security.md](docs/security.md). In short:

- **Authorisation stays on the server.** The device holds only what the server already sent that
  principal. The worker decides when a stored page is fresh enough to show, and never who may see
  it.
- **Signed-in data is partitioned per principal.** The partition id is an HMAC of the principal
  under a server secret, so the browser can tell partitions apart without learning who they
  belong to. A change of partition destroys the previous one.
- **Stored principal data is sealed at rest** with AES-GCM under a non-extractable key. Deleting
  the key makes the data unreadable (crypto-shredding). This is not a defence against script
  running on the site's origin.
- **Logout wipes before the request leaves**, offline too, for every tab of the origin.
- **Revocation is bounded by freshness.** A principal route is hard-bounded at five minutes by
  default, and the first required sync after a permission change drops the page.
- **The page runtime loads with SRI** from the CDN, or from the site's own origin for strict
  content security policies. If it fails to load, the page works as it did without spool.
- **Analytics are deferred, never fabricated.** Held events go to their original endpoint later,
  and events past their age cap are dropped and counted.

## Known Limitations

Spool lists what it does not protect against, rather than leave it to be found. The current list
is the [Open Limitations](docs/security.md#open-limitations) table. Read it before you put
signed-in data behind spool.

## Maintenance

Gregory Mitchell maintains spool. Dependencies are kept current through Renovate, and every change
runs the full gate in CI: typecheck, the unit and node suites, the browser lane in Chromium,
Firefox and WebKit, and the check that the published impact page matches its readings.

Security-relevant contributions are welcome through pull requests. A fix for a reported issue
lands with a regression test that fails without it. Keep exploit details out of public pull
requests until the advisory is published.

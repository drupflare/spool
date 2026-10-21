# Security Model

This page is the threat model for a security reviewer. Each claim names the file and function that make it true, and says whether a test covers it. A claim read from the code with no test says so. The wire formats are in [protocol.md](protocol.md).

## Scope

The page covers these parties and places:

- a second person who uses the same browser profile after the first one signs out
- a signed-out visitor
- a network observer
- script running on the site's origin
- the CDN host that serves the page runtime
- a caller of the `/.spool/*` endpoints, who needs no credentials
- a holder of the purge secret
- the operator of an analytics sink

It does not cover a compromised server, a compromised browser, or malware that reads the device's disk.

## What the Device Holds

The worker keeps these stores. Sealed means AES-GCM ciphertext at rest, described under [Sealed Stores](#sealed-stores).

| Store               | Where                                                             | Holds                                                                                                  | Sealed | Removed by                                                             |
| ------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------ | ---------------------------------------------------------------------- |
| Public replica      | IndexedDB `spool`: `artifacts`, `records`, `projections`, `meta`  | public artifacts, records, projections, tag versions, the cursor, the site's security headers          | no     | `Spool-Clear: *`, a `reset` sync, a runtime version change             |
| Principal partition | IndexedDB `spool-p-<partition id>`                                | principal artifacts, records, projections, replica meta (with the security headers of principal paths) | yes    | a `logout` path, `Spool-Clear`, a change of partition, `session-ended` |
| Persistent keys     | IndexedDB `spool-keys`, store `keys`                              | one non-extractable key per partition with `persistent` retention                                      | n/a    | with its partition                                                     |
| Current partition   | IndexedDB `spool-keys`, store `meta`                              | the id of the partition in use                                                                         | no     | with its partition                                                     |
| Session keys        | worker memory                                                     | one key per partition with `session` retention                                                         | n/a    | with its partition; also lost when the browser stops the worker        |
| Beacon queue        | IndexedDB `spool`, store `beacons`                                | held analytics requests, view events, loads reports, flush clocks                                      | no     | a flush, or the age cap. A logout sends or drops the same-origin ones  |
| Cache storage       | `spool-static-<version>`, `spool-assets-<version>`, `spool-third` | static files and the manifest, immutable same-origin assets, allowed third-party files                 | no     | caches of older versions on activation. Not by a logout                |

The device holds only what the server already sent that principal. The worker has four sources of artifact content: `/.spool/artifact`, the `artifacts` list in a beacon answer, the `catalogue` list in a beacon answer, and a response it fetched itself for a `static` route. The `artifacts` list is built without an identity, so it holds public artifacts only, and `accept` (`src/sw/runtime.ts`) discards any artifact whose scope is not `public`. The `catalogue` list is built with the identity of the beacon request, and `acceptCatalogue` keeps a principal entry only when the answer's `Spool-Partition` equals the partition the worker holds. A principal artifact from `/.spool/artifact` is stored only when the response's `Spool-Partition` equals the partition the worker holds (`provision`, `src/sw/runtime.ts`). `tests/node/partitions.spec.ts` covers an artifact answered for another partition, and `tests/node/catalogue.spec.ts` covers a catalogue answered for another one.

A route with `persist: false` keeps its artifact in worker memory and writes nothing to IndexedDB.

## Authorisation

Authorisation runs on the server. `buildArtifact` (`src/server/spool.ts`) resolves the identity from the request, answers `401` for a principal route with no identity before it runs `depends` or `load`, and passes `ctx.identity` to `load`. Only what `load` returns reaches the device. `decorate` writes `Spool-Artifact` for a principal route only when the identity resolves. `tests/unit/server.spec.ts` covers the `401` and the header rule.

The worker authorises nothing. It decides whether to show a stored page from the partition it holds and the route's freshness bound. It cannot show a visitor data the server never sent that partition. It can show a page the server sent earlier after the server's view of the visitor's permissions has changed, for as long as [Revocation](#revocation) describes.

### Endpoints That Need No Credentials

Four paths answer anyone.

| Path                        | What a caller learns or can do                                                                                                                                                                                                                                                                                                  |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/spool-sw.js`              | the full worker config: every route's pattern, scope, freshness and retention, the compiled templates, beacon and logout paths, collector entries, the third-party allowlist, provisioning priors and the client tag                                                                                                            |
| `/.spool/sync`              | with `from=0`, every tag that has changed since the vector began, each with its version. Tag names and the write rate are public. With an `identity` option the answer also carries the caller's own partition id in `Spool-Partition`                                                                                          |
| `/.spool/artifact?path=...` | the artifact of any public route. Each call runs `depends` and `load`, and the answer is `no-store`                                                                                                                                                                                                                             |
| `/.spool/beacon`            | accepts a batch from anyone. `parseBeaconBatch` checks structure, never truth, so a sink receives forged events. A batch's `want` makes the server build up to 8 public artifacts per request, and its `catalogue` makes the server run the named route's `catalogue` function and build up to 32 pages (`MAX_CATALOGUE_BUILD`) |

A template is code that ships to every visitor, so it must hold nothing private. Page data is what carries private values, and it travels only in an authorised artifact.

The server sets no CORS headers on `/.spool/*`, so a page on another origin cannot read these answers. It can still cause the requests. `respondBeacon` reads the body as text and does not check `Content-Type`, so another site can post a batch with a request that needs no preflight. Nothing rate-limits any of these paths. Treat sink data as untrusted input, and put a rate limit in front of the paths if build cost or forged events matter.

The error text of a `ProtocolError` that route code throws reaches the caller in a `400` (`answer`, `src/server/spool.ts`). Any other error answers `internal error`, and `tests/unit/server.spec.ts` checks that a thrown message does not leak.

## Partitions and the HMAC

A route with `scope: 'principal'` is stored in a partition per principal. The partition id is an HMAC-SHA-256 under the server secret over `spool-partition:1`, a NUL byte and the principal, encoded as 43 base64url characters (`partitionId`, `src/server/identity.ts`). The browser can tell partitions apart and learns nothing about the principal from the id. A different secret gives a different id for the same principal, and `tests/unit/server.spec.ts` checks that 500 principals get 500 ids.

- The same principal gets the same id on every device and in every session, so anyone who reads ids from two devices can tell they belong to one principal. They cannot tell which.
- The id is the IndexedDB database name `spool-p-<id>` and is stored in clear in `spool-keys`. A reader of the profile sees that a partition exists. Testing a guessed principal against an id needs the secret.
- `secret` is a string or a `Uint8Array`, and the code enforces no minimum length. Use a long random value and keep it out of the client.
- Rotating the secret changes every id. On a device's next decorated response the worker sees a different partition, switches, and destroys the old one, so a rotation wipes every device's local principal data.
- The worker believes any same-origin response that carries spool headers. It cannot tell a header the server meant from one an attacker who controls a response injected, so protecting the origin's responses is outside what partitions give.

The worker swaps the principal store under a lock (`serial`, `src/sw/runtime.ts`), so two responses never swap it at once. `SealedStorage.kill` turns writes into no-ops and reads into empty answers once a partition is shut, so a request that outlives a wipe cannot bring the store back. `tests/node/partitions.spec.ts` covers a write after the store is shut and a request that outlives a logout.

## Sealed Stores

`sealedStorage` (`src/sw/seal.ts`) wraps a partition's storage.

- The cipher is AES-GCM with a 256-bit key from `crypto.subtle.generateKey` with `extractable: false`, a fresh random 12-byte IV for each value, and additional data of `<partition>`, a NUL byte, `<kind>`, a NUL byte and `<id>`. The kinds are `artifact`, `record`, `projection` and `meta`.
- What is sealed: the whole stored artifact (its body and its dependency tags), each record, each projection and the replica meta (cursor, tag versions, sync clock, version).
- What stays readable: artifact ids, which are request paths, record and projection ids and their versions, because IndexedDB uses them as keys, and the partition id. `tests/node/partitions.spec.ts` reads the rows and checks that each holds only its key fields and ciphertext.
- The additional data binds a value to its partition, kind and id. A row copied to another partition, another id or another kind does not decrypt. The test covers the first two.
- The additional data holds no version or counter. A ciphertext recorded earlier for the same slot still decrypts, so the seal detects relocation and does not detect rollback. A party who can write to the profile's IndexedDB can replace a row with an older one.

`retention` picks the key. The default is `session`.

| Retention    | Key                                                                                                        | After a worker restart                                                               |
| ------------ | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `persistent` | a non-extractable `CryptoKey` in IndexedDB `spool-keys`, per partition (`idbVault`, `src/sw/partition.ts`) | readable. Survives a worker restart and a browser restart                            |
| `session`    | a `CryptoKey` in a `Map` in worker memory                                                                  | lost. The sealed rows read as absent, and `getArtifact` deletes a row it cannot open |

An artifact takes the retention of its route. Records, projections and the meta belong to no one route and use `persistent` when any principal route is `persistent`, and `session` otherwise. `tests/node/partitions.spec.ts` covers a restart with one route of each kind.

Deleting a key makes what it sealed unreadable. That is crypto-shredding, and `destroy` runs it in this order: shut the store, delete the keys, delete the database (`idbPartitions`, `src/sw/partition.ts`).

The seal is not a defence against these:

- **Script on the origin.** See [Script on the Origin](#script-on-the-origin).
- **A reader of the whole browser profile, with `persistent` retention.** The key and the ciphertext live in the same profile. `extractable: false` stops script from exporting the key. Whether a browser writes the raw key bytes into its profile files is the browser's choice, and spool has not tested it. Do not rely on `persistent` against disk forensics.
- **Anything while the worker runs.** A `session` key sits in worker memory and the data is readable by the worker.
- **Rollback of a row.** See above.

The public replica, the beacon queue and Cache storage are not sealed.

## Script on the Origin

Any script that runs on the site's origin can use whatever the page can. Four ways, read from the code and not covered by a test:

- It can load a same-origin frame at a principal route when the site's headers allow framing. The worker answers a navigation from the sealed store (`navigate`, `src/sw/runtime.ts`) with the frame and content-security headers the network answer carried, so `X-Frame-Options` and `frame-ancestors` apply to it as they do to a network view (see [Content Security Policy](#content-security-policy)).
- It can `fetch` a principal `data` route. `dataFile` answers any `GET` for such a route from the stored value.
- It can call the server with the visitor's cookies, as it can on any site.
- It can send `spool:partition`, `spool:graph` and `spool:status` to the worker and read the ids it holds. The replies list ids and counts, never content (`message`, `src/sw/runtime.ts`).

Escaping is part of rendering. The template interpreter HTML-escapes every `{{field}}`. `{{{field}}}` prints raw, and `defineRoute` refuses it for a field not listed in `trusted` (`compileTemplate`, `src/protocol/template/compile.ts`). Assembly fragments and slots are inserted by string replacement with no escaping, because they are markup from the server (`assemble`, `src/protocol/assembly.ts`), so a slot built from visitor input must be escaped in `load`. A `projection` route renders through the site's own function, and escaping there is that function's job.

## Logout and the Wipe Order

`SwConfig.logout` lists patterns. A same-origin request whose path matches one, with any method, takes the worker through `sendSameOrigin` and then `wipePartition('logout')` before the request is sent (`run`, `src/sw/runtime.ts`). The sequence:

1. Send the held same-origin beacons, described below.
2. Wait for earlier partition changes (`serial`).
3. Set the in-use partition to none, so no later view reads it.
4. Clear the stored partition id.
5. `destroy`: shut the store (`kill`), delete the keys (`shred`), delete the IndexedDB database.
6. Broadcast `{ type: 'spool:cleared', reason: 'logout' }` to every page of the origin.
7. Send the logout request.

Step 1 is the only step that uses the network. A held same-origin beacon is replayed with the browser's cookies (`credentials: 'same-origin'`), so one held from the user who is signing out would reach the server under whoever signs in next. `sendSameOrigin` (`src/sw/analytics.ts`) takes the held same-origin requests that are not spool's own events out of the queue and replays them while the old session is still the browser's. A request that fails, or that takes longer than `LOGOUT_SEND_MS` (3 seconds), is dropped and counted under the vendor `same-origin` in the `/.spool/dropped` record, and after the first thrown error the rest are dropped without a try. Nothing is replayed under another session. Held cross-origin events carry no cookies and keep their ordinary flush. The wipe itself does not wait for the network, so it completes with the network down, and `tests/node/partitions.spec.ts` checks the logout offline and with the network up.

Only a logout path takes this step. A change of partition or a `Spool-Clear` arrives in a response, after the browser already holds the new session's cookies, so a same-origin beacon held before it can still replay under the new session. One worker serves every tab, so one wipe empties the principal store for all of them. Each page receives the broadcast and the page runtime raises a `spool:cleared` event on `window`. A page has to blank what it shows, because spool does not touch the DOM.

A `Spool-Clear` header, or a navigation answered without `Spool-Partition`, takes the same path (`early`, `src/sw/runtime.ts`). It runs before the response is handed back, and a logout answer, which still names the identity it answered, cannot bring the partition back. `tests/node/partitions.spec.ts` covers both.

The worker reads `Spool-Clear` on its own (`decodeEnvelopeOrClear`, `src/protocol/envelope.ts`). When another spool header on the response is malformed, the worker drops every other field and still applies a valid `Spool-Clear`. A `Spool-Clear` that is itself malformed counts as `*`, so a bad value wipes and never keeps data. A response that names another protocol version is left alone. `tests/unit/envelope.spec.ts` and `tests/node/partitions.spec.ts` cover both cases.

Left in place by a logout:

- the public replica
- the beacon queue, apart from the same-origin requests sent or dropped above. Its bodies are whatever the page posted to its analytics endpoints
- every Cache entry
- what the page already rendered, and the browser's own HTTP cache

A `logout` pattern matches on the path alone. A `GET` to it, such as a link or a cross-site top-level navigation to that URL, wipes the local copy of the principal store. It leaves the server session alone unless the application's own logout handler ends it on `GET`.

A sign-out the worker never sees, such as a session that expires on the server or a sign-out in another browser, leaves the store in place. See [Revocation](#revocation) and [The Open Window](#the-open-window).

## Revocation

Spool has no model of permissions. The application tags a page with the permission it needs, for example `perm:<principal>`, and calls `spool.invalidate` when the permission goes. `tests/node/partitions.spec.ts` covers the result on a fake clock:

- Within the route's `maxStale`, the page shows with no request, even though the permission is gone. The default for a principal route is 300 seconds.
- Past `maxStale`, a hard route runs a required sync with `need`, which names the page's tags. The tag moved, the artifact is dropped, and the network answers. That is the first required sync.

The consequences, each read from `decide` in `src/sw/runtime.ts`:

- The exposure after a revocation is up to `maxStale` from the page's last validation, plus any time the visitor does not view the page. Nothing pushes to a device. A device that never returns holds its data until it does, or until it is wiped.
- A page whose tags omit the permission is not revoked by invalidating the permission.
- With `offline: 'serve'` on a hard principal route, a device that is offline past the bound shows the stored page. The default `refuse` sends the view to the network, which fails.
- A `soft` principal route shows the stored page first and syncs after, so it shows one stale view past the bound.
- A sync that fails counts as offline.

## Catalogue Entries

A catalogue puts the data of pages the visitor has not opened on the device ([protocol.md](protocol.md#catalogue)). The entry is data the server would send on a visit, built by the route's `load` with the identity of the beacon request, so it holds nothing the visitor may not see. Five things follow from the visitor never having asked for it.

- **It sits on the device unopened.** A public entry is in the public replica, which is not sealed, so anyone who reads the profile reads it. A principal entry is in the sealed partition store. Script on the origin can list the ids of both through `spool:graph` and `spool:partition`, and can `fetch` a principal `data` entry once the route serves it.
- **A revoked entry nobody opens is dropped by the sweep.** Revocation reaches a stored page through a required sync that names its tags ([Revocation](#revocation)), and no page names an entry the visitor never opens. So every sync of a principal page also names the dependency tags and drop tag of the unopened catalogue entries in that partition (`Replica.sweep`), and the first one after a tag moves drops the entry. When those ids and the page's own are more than `MAX_NEED`, the worker makes a full sync by cursor. `tests/node/catalogue.spec.ts` covers the drop, the full sync, and the control where nothing was revoked.
- **The exposure is the one a stored page has.** Opening an entry goes through the route's `maxStale` check like any page, so a permission revoked within the bound still shows it. A device that makes no required principal sync keeps the entry until the visitor returns or the partition is wiped, as [Revocation](#revocation) says of any page.
- **A server only sends principal entries to a worker that sweeps.** The batch says `sweep: true`, and `createSpool` skips principal routes when it does not. A second worker implementation that does not sweep must not send it. A request that resolves to nobody gets none, and the worker keeps a principal entry only for the partition it holds.
- **Save-Data sends nothing.** The server reads `Save-Data: on` from the beacon request. A proxy that strips the header, or a server that never sees it, sends a catalogue to a visitor who asked the browser to save data.

The catalogue request names the path of the page the visitor is on. A page the worker showed locally made no request and `spool.view` never carries a path, so this request is the one place the server learns the path of a page it did not serve. The worker sends it only for routes that declare `catalogue`, once per path while it runs, with a flush that leaves anyway. A site that does not want the server to learn local views leaves `catalogue` off.

A catalogue request costs the server a call to the route's `catalogue` and up to `MAX_CATALOGUE_BUILD` page builds, with no credentials and no rate limit. The route's `catalogue` receives a context whose request is a `GET` carrying the headers of the beacon request, cookies included. Sweep tags go in the `need` query like any other tag name, so use opaque ids for anything sensitive ([Sync Tag Names](#sync-tag-names)).

## The Open Window

The worker learns who is signed in only from `Spool-Partition` on a response that reaches it. A local view makes no request, so it learns nothing. Between a sign-in and the first response that names the new partition, a local view of a principal route reads the store of the previous partition.

It happens in two cases:

- The sign-in response carries no spool headers. The sign-in completes in a handler outside `spool.handle` and `decorate`, or on another origin.
- The sign-in response carries the previous partition. `decorate` resolves the identity from the request, and the request that signs a visitor in, or switches accounts, still carries the identity from before.

### The Required Sync Closes It

`/.spool/sync` names the identity it sees. When `createSpool` has an `identity` option, `answer` (`src/server/spool.ts`) resolves the request's identity and `respondSync` (`src/server/sync.ts`) sends `Spool-Partition` for it, or no partition when the request resolves to nobody. `fetchSync` (`src/sw/runtime.ts`) reads the answer's headers through `early` before it uses the sync result. A different partition swaps the principal store and destroys the previous one, and no partition wipes the principal store (`session-ended`), the same as on a navigation. A hard principal route runs a required sync once its page is past `maxStale`, so the previous visitor's page is not shown after that sync: the swap or the wipe happens first, the page is gone from the store, and the view goes to the network.

The window therefore ends no later than the route's `maxStale` after the page was last validated, plus the next view of a principal page. The default for a principal route is 300 seconds. Inside `maxStale` the stored page still shows, and a sign-in elsewhere shows the previous visitor's page until the bound passes. Two cases reach the sync later. A `soft` principal route shows the stored page for the view that finds the bound passed and syncs after it, so that one view shows the previous visitor's page, and with `sync: 'deferred'` the sync waits for a network moment. A sync that fails counts as offline, and `offline: 'serve'` then shows the stored page. `tests/node/partitions.spec.ts` covers a sign-in and a sign-out the worker never saw, on a fake clock. The sync carries a partition only when the server has the `identity` option, and a worker holds a principal partition only from such a server.

The application can close the window sooner. The sign-in and account-switch handlers set the new value on their own response:

```ts
headers.set('spool-partition', await spool.partition(user));
```

`early` applies a differing `Spool-Partition` before it returns the response, and `switchTo` destroys the previous partition before then (`src/sw/runtime.ts`). A navigation answered with spool headers and no partition, such as a sign-out, wipes the store for the same reason. The mitigation does not cover a sign-in that never passes through the handler, and the required sync is what ends the window for one.

## Cookies in Proxy Mode

The proxy cannot read the application's session, so it reads cookies (`decline` and `setsPrivateCookie`, `src/proxy/eligible.ts`; `handle`, `src/proxy/proxy.ts`).

- A request with a cookie whose name is not in `publicCookies`, or with an `Authorization` header, is ineligible on a public route. The proxy forwards it untouched. When the answer is a `200` page it also adds `Spool-Invalidate` for `spool:artifact:<path>`, so the worker drops its copy of that path. A query-string request is forwarded with no drop.
- A response that sets a cookie whose name is not in `publicCookies` carries `Spool-Clear: *`, whatever the method or status. That wipes the principal store and the public replica on the device that receives it. The check reads the cookie name only, so a `Set-Cookie` that deletes a cookie counts too, which makes a logout clear. `tests/node/proxy.spec.ts` covers the clear and the allowlist.
- `publicCookies` is a statement that a cookie carries no identity, such as a bot-check or load-balancer cookie. Listing a session or login cookie there removes the protection. A login no longer clears, and a signed-in request is no longer ineligible.
- A principal route in proxy mode keeps the clear rule. An origin that rolls a session cookie on every response clears the device on every response unless the cookie is listed, and listing it disables the login clear. The proxy cannot tell a rolling session cookie from a login, so that trade is the operator's to make.
- A cookie set without passing through the proxy, by script or by another host, produces no clear. The device can show a stored copy of a public page, which is the signed-out variant, to a visitor who has since signed in. It shows it until a cookie-bearing request for that path drops the copy, or a sync invalidates it. The copy holds public data only.

`createSpool` does not inspect `Set-Cookie`.

## Sync Tag Names

Tag names are readable. A tag appears unsealed in the `need` query of a sync request, in the `changed` map of a full sync, in `Spool-Artifact` and `Spool-Invalidate` headers, in the `deps` of an artifact and in the `have` query of an artifact request. `GET /.spool/sync?from=0` returns every tag that ever changed to any caller. A tag such as `grades:alice` or `perm:alice` tells an observer that the principal exists and when their data changes. The sealed store protects tags at rest and does nothing for them on the wire or on the server.

Use opaque ids for anything sensitive, for example a random id or an HMAC of the principal. Record and projection ids are IndexedDB keys, so they sit in clear at rest too. A principal route syncs with `need`, which names only the tags that page reads and not the whole diff. The cursor also shows the site's global write rate.

## Script Delivery

By default the server serves the page runtime itself at `/.spool/<version>/client.js` with `Cache-Control: public, max-age=31536000, immutable`. That path suits `script-src 'self'` and trusts no host beyond the site's own (`tests/unit/server.spec.ts`).

With `cdn: { integrity }` the injected tag is `<script src="https://cdn.drupflare.com/spool/<version>/client.js" integrity="sha384-..." crossorigin="anonymous" defer data-spool-client>`. The browser refuses a file whose sha384 differs. The hash is in the release notes and in `dist/cdn/manifest.json`, schema 2 (`scripts/cdn-manifest.ts`).

- A cross-origin SRI load needs `Access-Control-Allow-Origin` on the file. The repo does not set it. `verifyRemote` (`scripts/publish-cdn.ts`) reads the file back after a publish with an `Origin` header, fails unless the header is `*` or the probe's origin, and `tests/node/cdn.spec.ts` covers that check.
- A release key is immutable. `publish` refuses to overwrite one (`remoteExists`, `tests/node/cdn.spec.ts`). Each commit to `master` also gets one under its nightly version, `spool/<version>-<commit>/`, published before the nightly package that points at it. Dev keys under `spool/dev-<branch>` are overwritten on every push and cached for five minutes (`DEV_CACHE`). Never pin a dev URL.
- A script that fails to load, or fails the hash, leaves the page working as it did before. No worker registers.
- SRI covers the page runtime only. The worker script has to be same-origin, and the server or the site's own file serves it. The one-line form `importScripts('https://cdn.drupflare.com/spool/<version>/spool-sw.js')` has no integrity check. It trusts the CDN host with the worker, and a worker can answer any request of the origin, which is more than a page script can do. Serve `spool-sw.js` from the site's own storage to avoid that trust.
- `src/server/embedded.ts` holds the worker core and page runtime as generated text. `tests/node/embedded.spec.ts` fails when it drifts from the source.

## Content Security Policy

Spool writes no `Content-Security-Policy` and configures none. `decorate` adds no policy. The worker reads the security headers of network answers and replays them on local renders, described below.

- The injected tag carries no `nonce`. A policy that allows only nonce or hash scripts blocks the tag. The page then works as it did before, with no worker. The default same-origin path needs `'self'`, and the CDN form needs the CDN origin in `script-src`.
- A page the worker renders from an artifact (template, assembly, projection and `data` routes) is answered with the site's security headers and a `Content-Type` of the worker's own (`navigate` and `dataFile`, `src/sw/runtime.ts`). The headers are `Content-Security-Policy`, `Content-Security-Policy-Report-Only`, `X-Frame-Options`, `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`, `Cross-Origin-Opener-Policy`, `Cross-Origin-Embedder-Policy` and `Cross-Origin-Resource-Policy` (`POLICY_HEADERS`, `src/sw/policy.ts`). No other header of the network answer is replayed, `Cache-Control` and `Set-Cookie` included.
- The worker keeps a set of those headers from a `200` HTML navigation to a route's path, with no query string and no redirect, and from a `200` `data` read of its path (`keepPolicy`, `src/sw/runtime.ts`). Any `200` same-origin HTML navigation also replaces the site-wide set. A local render replays the path's own set, and a path with none of its own takes the site-wide set, which is the latest one seen. A set can be empty: a site that sends none is rendered locally with none.
- A path with no set of its own and no site-wide set is not answered locally. `decide` returns the reason `refused` and the view goes to the network, which stores the sets for the next one. The worker never serves a page without the policy the site sent with it. A view in shadow mode is not affected.
- The sets live in the replica meta (`keepPolicy`, `src/sw/replica.ts`): the site-wide set and the sets of public paths in the public replica, and the set of a principal path in the sealed meta of its partition. Each replica keeps the sets of its 128 most recent paths (`MAX_POLICY_PATHS`). They go when the store does: `Spool-Clear: *`, a `reset` sync and a runtime version change empty the public replica, and a partition's sets go with its partition. A worker restart keeps them.
- `tests/node/strategies.spec.ts` covers the capture, the fallback, the refusal, a restart and the wipe, `tests/node/partitions.spec.ts` covers a principal page, and `tests/browser/security.pw.ts` checks in Chromium, Firefox and WebKit that a local view carries `X-Frame-Options: DENY` and a policy that forbids inline script, and that an inline script does not run. A `<meta>` policy is no longer needed for a local view.
- A policy that carries a nonce chosen for each response replays an old nonce. Markup the worker renders from a template holds none that matches, so inline scripts that rely on the nonce fail on a local view. Read from the code, no test covers it. Use `'self'` or hashes.
- A `static` route replays the headers of the response it stored, minus the transfer headers (`replayHeaders`, `src/sw/static.ts`), so a stored file keeps its `Content-Security-Policy`. `tests/node/static.spec.ts` checks it.
- A view in shadow mode serves the network answer, so it has the application's headers.
- A policy has to allow the worker script the browser registers. Spool does not test a restrictive `worker-src` or `child-src`.

## Clear-Site-Data

`decorate(request, response, { hardReset: true })` adds `Clear-Site-Data: "storage"`. It asks the browser to reset everything the origin holds, the service worker included. Safari's support is unverified, so rely on the worker's own wipe. The worker wipes before the logout request leaves. The header acts only after a response arrives, so it needs the network. After the header lands, the next views are plain network views until the page registers the worker again.

## Trimmed Stylesheets

A trimmed stylesheet is a correctness risk and not a confidentiality one. The proxy only removes rules from a file that every visitor already receives, and the manifest holds public stylesheets and the words of public pages and scripts. Nothing a visitor sends goes into it. A wrong trim shows a page with a rule missing. It leaks nothing and it changes no access decision.

Two checks stand between a stale or incomplete manifest and a visitor (`src/proxy/proxy.ts`, `src/trim/manifest.ts`).

- **The hash.** A stylesheet is served trimmed only when the sha256 of the origin's decoded bytes equals the manifest's `source`. A deploy that changes the file makes the manifest wrong for it, so the proxy serves the origin's bytes and counts a mismatch until the manifest is rebuilt.
- **The guard.** Every HTML response is read before it leaves. A page that has a token the trim removed a rule for, or loads a same-origin script the manifest was not built with, links the full file through `spool-trim=0`. This covers pages the crawl never saw, including pages the proxy does not keep, such as a query string or a signed-in page.

`tests/node/proxy.spec.ts` and `tests/browser/trim.pw.ts` cover both. What the guard cannot see:

- A class that a script from another origin adds after load. `buildTrimManifest` reads the words of the foreign scripts the crawl loaded, so it covers what they did on the day of the crawl. The guard never reads those URLs, so a vendor that ships a new class later is not caught until the manifest is rebuilt.
- Markup injected after load from an endpoint the crawl did not request, and a class built at runtime from parts, such as `'btn-' + kind`, where no whole class name appears in the HTML or a script.
- A page served in a charset other than UTF-8. The guard reads the body as UTF-8, and a page it rewrites is sent as UTF-8.
- A stylesheet reached through `@import` inside another stylesheet. It is not linked from the page, so the guard cannot send it a `spool-trim=0`, and a manifest built from linked files holds no entry for it.

A site that cannot accept these limits should not pass `trim`. The same saving is available from a build step that purges with a safelist, which puts the same decision in the site's hands.

## Images and Video

The `images` option hands bytes the origin sent to a decoder, and a decoder is attack surface: a crafted JPEG or PNG is parsed by whatever `encoder` the caller passes. spool imports no decoder. tinyimg, the encoder the README wires in, runs as WebAssembly, so a fault in it stays inside the module's memory and cannot reach the proxy process. The proxy sets no time limit on the encoder, and an encoder that never returns holds that request open.

Four rules bound what reaches it (`src/media/image.ts`).

- **What converts.** A `200` whose `Content-Type` is `image/jpeg` or `image/png` and whose first bytes are that format's magic number. A WebP, a GIF and a body that disagrees with its header never match. A response with `Set-Cookie`, a request with `Range` or `Authorization`, and a non-`GET` are never converted.
- **Size.** A file below `minBytes` or above `maxBytes` goes out as it came. A `Content-Length` over `maxBytes` is refused before the body is read. A response without one is read first, the way the proxy reads an HTML page.
- **Fallback.** An encoder that throws, returns no bytes or returns bytes that are not smaller leaves the origin's bytes in the response with a `200`. A decoder fault costs the visitor the conversion and nothing else.
- **The cache.** Converted bytes are keyed by the sha256 of the origin's bytes with the quality and width. The proxy fetches the origin for every request, so a cache hit saves the encoder and never replaces the origin's answer, and one visitor's image cannot reach another. The converted response keeps the origin's `Cache-Control`, so a `private` image stays private.

`video` edits start tags in text the origin already sent. It adds no script and changes no attribute value except `preload`. A page rewritten because of `Save-Data` or `ECT` is made `private`, varied on both headers and declined, so one visitor's connection never becomes another's stored page. `tests/node/media.spec.ts` covers each rule.

## Purge Endpoint

`POST /.spool/purge` exists in proxy mode only (`respondPurge`, `src/proxy/purge.ts`).

- With no `purgeSecret`, every call answers `403`, so a proxy that never configured purges cannot be made to bump its vector. `tests/node/proxy.spec.ts` covers it.
- The credential is `Authorization: Bearer <secret>`. `equalSecrets` runs both values through HMAC-SHA-256 under a random key made once per isolate, then XORs the two 32-byte digests over their whole length with no early exit. The secret's value and its length do not change the work. JavaScript offers no timing guarantee, and spool has not audited an engine for one, so the claim is limited to the removal of the data-dependent exit.
- Nothing rate-limits the endpoint, locks it out after failures or protects a request from replay. Any holder of the secret can bump any tags, up to 1000 per call. The effect is that every device refetches. That is load on the origin, and no data leaves.
- A purge needs a bearer header and not a cookie, so a cross-site page cannot trigger one by browser request.
- The secret has no minimum length. Set it with `wrangler secret put PURGE_SECRET` on Workers, and call the endpoint over HTTPS only.

## Analytics and Third Parties

A request listed in `beacons` or matched by a `collectors` entry is held in IndexedDB, in clear, until a network moment. The page gets an answer at once, `204` for a `POST` and a one-pixel GIF for a `GET` (`collectorAnswer`, `src/sw/collect.ts`), so the page is told the request succeeded before it has been sent. An event older than the collector's `maxAgeMs` is dropped, counted and reported as `/.spool/dropped`, and it is never sent late.

- A same-origin replay carries cookies (`credentials: 'same-origin'`). A cross-origin replay sends none (`credentials: 'omit'`), so identity has to be in the payload (`replay`, `src/sw/runtime.ts`).
- The held body is whatever the page posted. It is not sealed and a logout does not remove it.
- Spool holds an event whether or not the visitor consented. Gate the analytics tag itself and ask counsel whether holding an event in IndexedDB needs consent where you operate.
- A `spool.view` event names the route the visitor came from (`from`): the route pattern of a same-origin referrer, such as `/node/:id`, or `external` for another origin. It reveals which kind of page preceded this one and nothing else. It never holds the referrer's URL, path, query string or the external site's name, and a same-origin path that matches no declared route is left out. Set `views: false` to stop the event.
- `thirdParty.allow` lets the worker keep a `GET` response from a listed origin, for a readable (CORS) answer at a URL that looks versioned or that the origin marks immutable (`versionClass`, `src/sw/thirdparty.ts`). `allowOpaque` is off. The worker checks no hash of the file. A file kept as `immutable` is never checked again, so one bad answer at a hashed-looking URL stays until the entry is evicted (`maxEntries`, oldest first). A `revalidate` file is checked at a network moment once it is a day old.

## What Spool Never Does

- **Authorise on the client.** The device holds only what the server already sent that principal. The worker has no access rule and no way to grant one.
- **Fabricate analytics.** The events spool writes itself are its own records: `spool.view`, `spool.loads` and the drop counts, which go to the `sink`. A vendor receives the body the page sent. Spool creates no vendor event. The page's immediate answer to a held request is the one thing it makes up, and it is stated above.
- **Replay programmatic ads.** The worker ignores every cross-origin request that matches no `collectors` entry and no `thirdParty.allow` origin (`classify`, `src/sw/router.ts`), and the browser handles those as it always did. Spool has no ad-specific code and no check against an operator listing an ad host.
- **Write.** The application owns every write. `spool.invalidate` announces one.
- **Infer dependencies from opaque HTML.** A route names its tags, or the origin names them in cache tag headers.

## Open Limitations

Each limitation is stated in the section it belongs to. This table lists them in one place.

| Limitation                                                                                                                                                                                            | Section                                                                                |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| A sign-in whose response the worker sees without the new `Spool-Partition` leaves the previous partition readable until the first required sync, which is no later than `maxStale` plus the next view | [The Open Window](#the-open-window)                                                    |
| A revoked permission shows for up to `maxStale`, nothing pushes a revocation, and `offline: 'serve'` shows a page past the bound                                                                      | [Revocation](#revocation)                                                              |
| Tag names and the write rate are readable by anyone through `/.spool/sync`                                                                                                                            | [Sync Tag Names](#sync-tag-names)                                                      |
| A sealed row is bound to its place and not to a version, so a row can be rolled back                                                                                                                  | [Sealed Stores](#sealed-stores)                                                        |
| `persistent` retention keeps the key in the same profile as the ciphertext                                                                                                                            | [Sealed Stores](#sealed-stores)                                                        |
| The seal gives no protection against script on the origin                                                                                                                                             | [Script on the Origin](#script-on-the-origin)                                          |
| A policy with a nonce chosen for each response does not match markup the worker renders, so its inline scripts fail on a local view                                                                   | [Content Security Policy](#content-security-policy)                                    |
| Assembly slots and fragments are not escaped                                                                                                                                                          | [Script on the Origin](#script-on-the-origin)                                          |
| A logout leaves the public replica, held cross-origin and spool events and Cache entries in place                                                                                                     | [Logout and the Wipe Order](#logout-and-the-wipe-order)                                |
| A change of partition or a `Spool-Clear` that is not a logout path does not send or drop held same-origin beacons, which replay under the new session                                                 | [Logout and the Wipe Order](#logout-and-the-wipe-order)                                |
| A `logout` pattern matches any method, so a `GET` wipes the local principal store                                                                                                                     | [Logout and the Wipe Order](#logout-and-the-wipe-order)                                |
| Proxy mode cannot tell a rolling session cookie from a login, and a cookie set outside the proxy produces no clear                                                                                    | [Cookies in Proxy Mode](#cookies-in-proxy-mode)                                        |
| `/.spool/beacon`, `/.spool/sync` and `/.spool/artifact` need no credentials and have no rate limit, and a flush can ask the server to build 8 artifacts and a catalogue of up to 32 pages             |
| A catalogue request names the path of the page the visitor is on, including a page the worker showed locally, which no other request or view event carries                                            | [Catalogue Entries](#catalogue-entries)                                                |
| An unopened principal catalogue entry stays on the device until a required principal sync names its tags, the visitor returns, or the partition is wiped                                              | [Catalogue Entries](#catalogue-entries)                                                | [Endpoints That Need No Credentials](#endpoints-that-need-no-credentials) |
| A trimmed stylesheet can lose a rule for a class that a later vendor script, late-injected markup or a runtime-built class name needs, which the guard cannot see                                     | [Trimmed Stylesheets](#trimmed-stylesheets)                                            |
| The purge endpoint has no rate limit or lockout, and any holder of the secret can bump any tag                                                                                                        | [Purge Endpoint](#purge-endpoint)                                                      |
| The `importScripts` form of the worker has no integrity check                                                                                                                                         | [Script Delivery](#script-delivery)                                                    |
| `Clear-Site-Data` support in Safari is unverified                                                                                                                                                     | [Clear-Site-Data](#clear-site-data)                                                    |
| The secrets, the partition secret and the purge secret, have no enforced minimum length                                                                                                               | [Partitions and the HMAC](#partitions-and-the-hmac), [Purge Endpoint](#purge-endpoint) |

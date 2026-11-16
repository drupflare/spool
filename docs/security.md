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
- It can `fetch` a principal `data` route. `dataFile` answers a `GET` for such a route from the stored value when the value is current and inside its bound, and sends any other request to the network.
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

Step 1 is the only step before the wipe that uses the network. A held same-origin beacon is replayed with the browser's cookies (`credentials: 'same-origin'`), so one held from the user who is signing out would reach the server under whoever signs in next. `sendSameOrigin` (`src/sw/analytics.ts`) takes the held same-origin requests that are not spool's own events out of the queue and replays them while the old session is still the browser's. A request that fails, or that takes longer than `LOGOUT_SEND_MS` (3 seconds), is dropped and counted under the vendor `same-origin` in the `/.spool/dropped` record, and after the first thrown error the rest are dropped without a try. Nothing is replayed under another session. Held cross-origin events carry no cookies and keep their ordinary flush. The wipe itself does not wait for the network, so it completes with the network down, and `tests/node/partitions.spec.ts` checks the logout offline and with the network up.

A response that changes the partition, carries a `Spool-Clear` or ends the session drops them as well (`dropSameOrigin`, `early`, `src/sw/runtime.ts`), with the same count. Such a response arrives after the browser already holds the new session's cookies, so the drop is the only step that can stop the replay. A response that names no change drops nothing; see [The Open Window](#the-open-window). One worker serves every tab, so one wipe empties the principal store for all of them. Each page receives the broadcast and the page runtime raises a `spool:cleared` event on `window`. A page has to blank what it shows, because spool does not touch the DOM.

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

A held same-origin beacon has no such bound. A flush at a network moment, or a standalone flush once the oldest is a day old, replays it with the browser's cookies, so a beacon held before a sign-in the worker does not see reaches the next user. `tests/node/partitions.spec.ts` marks that case `it.fails`, so the suite passes while it holds and fails when it is fixed. A response that names the new partition closes it (`dropSameOrigin`). A worker without partition storage drops nothing in the window: `early` returns when there is no host (from the code, not tested).

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

## Inline Artifact Data

With `inlineMaxBytes` above `0`, a public `template` page carries its own artifact in a `<script type="application/spool+json" data-spool-artifact>` element. The data is what `/.spool/artifact` would send to anyone without cookies: the server builds it for a request with no cookies, never for a principal route, and leaves it out when the route would be declined. Escaping `<`, `>`, `&`, U+2028 and U+2029 as `\uXXXX` keeps the text from ending the element or opening another tag.

The worker does not trust an element because it is in the page. It takes the last one, hashes its text and compares the hash with the `h` field of `Spool-Artifact`, which only the server's response headers carry. Markup a visitor or an editor puts in the page body cannot match that hash. The worker then runs `parseArtifact` and checks that the `id` is the path it asked for, the scope is `public` and the strategy is the route's own. A page that fails any step stores nothing, and the worker fetches the artifact as before. Script on the origin already reads whatever the page holds, so the element adds no reach beyond the data the endpoint serves to everyone.

An `assembly` page in proxy mode needs no element. The body is the artifact, and the worker stores it only when the hash of the body without the client tag equals `h`. See [The Body Carries the Artifact](protocol.md#the-body-carries-the-artifact).

## Query Routes

A route that declares `query` answers filters, sorts and pages of a collection on the device. The route is public. `defineRoute` refuses `query` on a `principal` route unless the route names a principal dataset in `query.dataset` and declares no `plan` (`tests/unit/route.spec.ts`, `tests/node/strategies.spec.ts`, `tests/node/principal-datasets.spec.ts` "allows query on a principal route only with query.dataset and no plan"). Without a principal dataset a query never runs over a sealed copy, and the device holds no per-principal collection for it; "Principal Datasets" below covers the case that does. The collection is what `/.spool/artifact` sends to anyone without cookies. A query the device answers is not sent to the origin, so the origin does not learn the filter. The view event carries the route's pattern and never the query string.

The proof is an integrity check of what the server sent. `datasetProof` records the item count and a SHA-256 of the canonical JSON, the server builds no artifact whose proof does not match (`verifyProof`, `src/protocol/query.ts`, called from `src/server/spool.ts`), and the worker computes it again from the stored copy before each answer (`shapeQuery` in `src/protocol/query.ts`, called by `renderLocal`). A copy that is partial, truncated by an interrupted write or edited after it was stored fails the check. The worker then drops it and sends the request to the network (`tests/node/strategies.spec.ts`, `tests/unit/query.spec.ts`). The proof does not say the array is the whole collection: that is the route's declaration, and an incomplete array with its own matching proof would answer queries with too few rows. It is not authorisation and not a signature. Script on the origin, or anything else that can write the store, can change the items and the proof together, and the worker would answer from them. A server response that carried a wrong collection would carry a matching proof. Authorisation stays on the server, and the page runtime and the worker are no more trusted with the collection than with any other public artifact.

A copy that is stale under the route's freshness contract is refreshed first on a `hard` route and shown first on a `soft` one, as for the path itself. A query string the schema does not declare, a repeated `sort` or an unlisted one, a number filter that is not a number, and a page past the last go to the network, which answers them as it always did. Nothing is stored under a URL with a query string, so a query string cannot add entries to the store or make one path hold more than one copy.

## Principal Datasets

Principal datasets ship off, and no external review of this feature has been done. Two switches turn one on, and both are needed: `defineDataset(name, declaration, { principalDatasets: true })` and `createSpool({ principalDatasets: true, identity })`. Without the first, `defineDataset` throws `bad-dataset`. Without the second, `createSpool` throws, `/.spool/dataset` answers `404` for the name, and the worker opens no dataset database for a partition. `tests/node/principal-datasets.spec.ts` covers both refusals and the flag-off case. The wire format is in [protocol.md](protocol.md#principal-datasets).

**What is held.** Each row is one record in `spool-principal-datasets`, keyed by partition, dataset and slot. The slot is the SHA-256 of a random per-dataset salt, the dataset name and the row key. The row key, the row value, the dataset meta and its digest are AES-GCM ciphertext under the partition's key, with the partition, dataset and slot as additional data. The salt sits only inside the sealed meta (`src/sw/principal-dataset.ts`). The partition id and the dataset name stay readable, since IndexedDB uses them as keys. `4. leaves no row value, field name or row key in any database, and a copied row does not open` scans every database for the strings it planted. It does not scan for values it did not plant.

**Key retention.** The key takes the retention that records and projections use: `persistent` when any principal route is persistent, `session` otherwise. A `session` key lives in worker memory. After a restart its meta does not open, the dataset is cleared, and the next sync seeds it again (`clears a dataset whose meta no longer opens, and reads it as absent`).

**What the server decides.** The server takes the identity from the request, never from the URL. With no identity it answers `401` with `{"error":"sign in"}`. A dataset function that throws `ProtocolError('dataset-forbidden')` gets a `403`. Every dataset function receives `ctx.principal`. A `principal` or `as` parameter in the URL changes nothing, and an `after` key from another principal's feed returns nothing from that feed (`derives everything from the identity: another principal key in the URL changes nothing`, `src/server/dataset.ts`). Which rows a principal may see is the site's code. spool passes the identity through and does not check what `head`, `changes`, `read` or `seed` return.

**Threat modes.** Nine threat modes, each with the test that holds it:

- **Two principals, back to back.** A's rows never reach B, and A's sealed rows are gone after the switch. `1. holds A, then B back to back: A rows never reach B and A sealed rows are gone`.
- **A late answer after a switch.** A response for A that arrives after the worker moved to B is discarded and writes nothing. `2. discards a response for A that arrives after the worker moved to B`, `2. ends a patch as refused epoch, writing nothing, when the side died while it was in flight`.
- **A response for another partition.** A response with no `Spool-Partition`, or with another one, is never applied. `3. never applies a response with no Spool-Partition or another one`.
- **Plaintext at rest.** `4. leaves no row value, field name or row key in any database, and a copied row does not open`.
- **Staleness and revocation.** A row that leaves the scope arrives as a delete, a `403` drops the dataset, and a principal removed on the server is wiped at the first view past the bound. `5. answers locally for maxStaleMs and goes to the network at the bound`, `5. a row that left the principal scope arrives as a delete and is gone from the next page`, `5. a 403 for the whole dataset drops its rows and keeps the partition`, `5. a principal removed on the server is served for at most maxStaleMs, then wiped`.
- **Wipes.** `6. a logout with a sync in flight wipes the rows and discards the late answer`, `6. the logout pattern, Spool-Clear and an account switch each delete the rows`.
- **Replays and bad proofs.** An older patch changes no row and no confirmation time, and a patch whose proof fails is dropped and reseeded once. `7. refuses a replayed older patch: the rows and the confirmation time stay`, `7. discards a patch whose proof fails and reseeds once, with exact requests`.
- **A key from another principal's feed.** `derives everything from the identity: another principal key in the URL changes nothing`.
- **The flag off.** Nothing is served or created, and principal pages behave as before. `9. serves no principal dataset, creates no database and leaves principal pages as they were`.

**Staleness.** Held rows answer a query locally while the last confirmed sync is younger than `maxStaleMs`. A confirmed sync is one that returned and verified, a "no change" answer included (`touch`, `src/sw/dataset-sync.ts`). A replayed older patch does not move it. A clock set back counts as stale (`decide`, `src/sw/runtime.ts`). Past the bound the view goes to the network, and the next network moment syncs the dataset. Nothing pushes a revocation to the device. A device serves a removed principal's rows for at most `maxStaleMs` after its last confirmed sync, so the window after a removal is that value. A device that does not return keeps the rows stored until it is wiped, as [Revocation](#revocation) describes for artifacts.

**Wipes.** A wipe deletes the partition's dataset rows and metas along with the rest of the partition, then shreds its key. `destroy` shuts the sealed store, shreds the key and deletes the stores, in that order (`src/sw/partition.ts`). Five events start a wipe:

- a request to the logout pattern, by any method (`run`, `src/sw/runtime.ts`)
- a `Spool-Clear` on a response the worker reads (`early`)
- a response that names another partition, which switches the store (`early`)
- a `401` on a principal response, recorded as `session-ended` (`principalFetch`)
- a navigation with no `Spool-Partition` (`early`)

A `403` on the dataset endpoint drops that dataset's rows and metas and nothing else. The next visit goes to the network with no dataset request (`5. a 403 for the whole dataset drops its rows and keeps the partition`). Background seeding of that dataset stays off until the partition changes (`datasetRefused`, `src/sw/runtime.ts`). The partition-change reset is not tested.

**Rollback.** A v0.3 worker never opens `spool-principal-datasets`. Its `destroy` shreds the key of the partition it wipes, and the v0.4 rows are sealed under that same key. So after a rolled-back worker logs out, the rows it left behind are ciphertext that no key opens. No v0.3 code deletes them. A v0.4 `destroy` for the same partition id does (`destroyPrincipalDatasets`). No test covers rollback.

**Limits.** A principal route cannot carry `query.plan`, so no join reaches a principal dataset (`src/protocol/route.ts`). A principal dataset cannot use `provision: 'auto'`, because the admission statistics in `src/server/dataset.ts` are kept per dataset name and shared across principals (`needs a positive maxStaleMs and refuses provision auto on a principal dataset`).

## Declared Writes

Declared writes ship off, and no external review of this feature has been done. `createSpool({ writes: { enabled: true, classes } })` turns them on. With the flag off the worker queues nothing and opens no `spool-writes` database, the page API answers `writes-off`, and `PUT /.spool/write` answers `403` with the same code (`refuses with writes-off, queues nothing and creates no spool-writes database while the flag is off`). Rows an earlier worker queued stay sealed and unsent under a worker with the flag off, and a wipe still deletes them; a later worker with the flag on sends them, and the server's `If-Match` check decides (`leaves a queued value alone under a worker whose config has no writes, and sends it once a worker with writes returns`).

A class is one write to one key for one principal, and the last value wins. `defineWrite` accepts only the `principal` scope and the `last-value` kind. A comment, cart, payment, counter, inventory change or audit record has no kind, so no declaration can queue one (`has no kind named %s`, `src/protocol/write.ts`).

**What is queued.** One record per partition, class and key sits in `spool-writes`. The partition, class and key are readable, since IndexedDB uses them as keys. The value, the versions, the write id and any conflict are AES-GCM ciphertext under the partition's persistent key, whatever the route's retention. A session key lives in worker memory, and an unsent value would be lost when the browser stops the worker (`idbWriteStore`, `src/sw/write.ts`). `keeps the partition, class and key readable and everything else ciphertext` checks the row.

**If-Match.** A flush sends `If-Match` with the version that the first edit since the last answered flush started from. The server needs exactly one version: a missing header is `428`, and a malformed one is `400` (`src/server/write.ts`). The version goes to the site's `apply` as `expectedVersion`. Spool does not compare versions itself, so `apply` must write only when the key is at that version, in one atomic step. A stale version gets `412` with the server's version and value. The device parks that record as `conflicted`, keeps the local value, and never retries it on its own. Only `resolve` settles it (`answers 412 with the server version and value when If-Match is stale`, `parks the record as conflicted with the local value kept and the server side stored`, `never retries by itself`).

**Spool-Write-Id.** The device makes one id per record and sends the same id on every retry. The server reads it as 16 to 64 characters from `A-Za-z0-9_-`. In memory, it keeps the last applied id and a hash of its body for each class, principal and key, up to `remember` slots (10,000 by default), forgetting the oldest first. A repeat of that id with the same body answers `200` with the current version and does not call `apply`. The same id with another body answers `422` `id-reused` (`answers a repeated id with the current version and applies nothing`, `refuses a repeated id with a different body`).

**What a replay cannot do.** Once a slot is gone, because of a restart, an eviction past `remember`, or a request that lands on another instance:

- A repeated id is not recognised. The request reaches `apply` with its old `If-Match`. Whether it writes depends on `apply`. The test site refuses it with `412`, since the first write had moved the version (``forgets the oldest slot past `remember`, and says so by applying a replay again``).
- A different body under the same id is not caught. The version check in `apply` is the only guard.
- A site with more than one instance needs `apply` to store `ctx.writeId` with the value. Without that, a retry that lands on another instance reads as a conflict. This is in the docs only, and no test covers it.

Two more limits do not depend on eviction:

- An id older than the last applied one is not matched. Only the version check refuses it.
- A repeat of the last applied id is answered from memory before the version is compared, so a repeat with a stale `If-Match` still returns `200`. No test covers that case.

**Device retries.** An edit made while a request for an earlier value is in flight, or after a failed attempt, waits in `next`. The retry then sends the same id and body (`keeps an edit made while a request is in flight for a later flush and never loses it`, `keeps an edit after a failed attempt out of the retry, so the retry stays identical`).

**Keys.** The server calls `key(ctx, request)` and refuses a `key` query value that does not match with `403 forbidden`, before `read` or `apply` runs (`refuses a key that belongs to another principal before reading or applying`). The device queues whatever key a page names, and the refusal comes at the first flush (`does not let a principal write the key of another, even when its queue holds it`).

**Logout with a queued write.** A logout first sends the held same-origin beacons, then wipes the partition. The wipe kills the queue, shreds the key and deletes the partition's `spool-writes` rows (`run` and `wipePartition`, `src/sw/runtime.ts`). No flush runs before the wipe, so a value that no flush has sent is lost and never reaches the server. A page that wants its values sent calls `spool.flush()` before the logout navigation. An account switch does the same to the old account's queue (`deletes the queue on a logout, sends nothing afterwards and refuses later calls`, `removes A's queue when B signs in, leaves B's rows, and never sends A's value as B`).

**Reads.** `spool:writes` lists each queued key with its state, versions and attempt count, and no value. `spool:flush` returns counts only. Neither exposes a stored value (`flushes on a page message, lists states without values, and resolves a conflict`, `reports counts only: no field of a flush carries a value`).

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
- A policy that carries a nonce chosen for each response replays an old nonce. Markup the worker renders from a template holds none that matches, so inline scripts that rely on the nonce fail on a local view. `tests/browser/security.pw.ts` shows it in Chromium: with `script-src 'self' 'nonce-N'`, the inline script of a network view runs, and the same page served from its artifact, under the kept header's nonce, does not. Use `'self'` or hashes.
- A `static` route replays the headers of the response it stored, minus the transfer headers (`replayHeaders`, `src/sw/static.ts`), so a stored file keeps its `Content-Security-Policy`. `tests/node/static.spec.ts` checks it.
- A view in shadow mode serves the network answer, so it has the application's headers.
- A policy has to allow the worker script the browser registers. Spool does not test a restrictive `worker-src` or `child-src`.

## Clear-Site-Data

`decorate(request, response, { hardReset: true })` adds `Clear-Site-Data: "storage"`. It asks the browser to reset everything the origin holds, the service worker included. Safari's support is unverified, so rely on the worker's own wipe. The worker wipes before the logout request leaves. The header acts only after a response arrives, so it needs the network. After the header lands, the next views are plain network views until the page registers the worker again.

## Shadow Mode

In shadow mode the worker serves the network answer and compares it with a local render of the same page. When the worker holds a render, it splits the response body into the visitor's stream and a copy (`branch`, `src/sw/static.ts`). For a non-200 answer, `differs` (`src/sw/shadow.ts`) returns at the status check without reading or cancelling the copy. The copy's capture stream then buffers every chunk until the copy is collected. No test checks that the copy is released.

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

A same-origin stylesheet that a page links with an `integrity` attribute fails under `trim`. The proxy does not change that attribute, so the browser checks the trimmed body against the hash of the full file and refuses it. On a page the guard rewrites, the link points at the full file and loads. On any other page the trimmed file is served and the stylesheet does not load. No test covers this. The [Open Limitations](#open-limitations) table lists it.

## Images and Video

The `images` option hands bytes the origin sent to a decoder, and a decoder is attack surface: a crafted JPEG or PNG is parsed by whatever `encoder` the caller passes. spool imports no decoder. tinyimg, the encoder the README wires in, runs as WebAssembly, so a fault in it stays inside the module's memory and cannot reach the proxy process. The proxy waits for the encoder at most `timeoutMs` (10 seconds by default), then serves the origin's bytes and leaves the encoder to finish. An encoder that never returns holds one task and costs no request. With `timeoutMs: false` the proxy waits without limit, and a request then stays open as long as the encoder does.

Seven rules bound what reaches it (`src/media/image.ts`, `src/media/responsive.ts`).

- **What converts.** A `200` whose `Content-Type` is `image/jpeg` or `image/png` and whose first bytes are that format's magic number. A WebP, a GIF and a body that disagrees with its header never match. A response with `Set-Cookie`, a request with `Range` or `Authorization`, and a non-`GET` are never converted.
- **Size.** A file below `minBytes` or above `maxBytes` goes out as it came. A `Content-Length` over `maxBytes` is refused before the body is read. A response without one is read first, the way the proxy reads an HTML page.
- **Fallback.** An encoder that throws, returns no bytes or returns bytes that are not smaller leaves the origin's bytes in the response with a `200`. A decoder fault costs the visitor the conversion and nothing else.
- **The cache.** Converted bytes are keyed by the sha256 of the origin's bytes with the quality, the width and, for a PNG, the mode. The proxy fetches the origin for every request, so a cache hit saves the encoder and never replaces the origin's answer, and one visitor's image cannot reach another. The converted response keeps the origin's `Cache-Control`, so a `private` image stays private.
- **Coalescing.** Requests with the same cache key share one encoder call while it runs. The key holds the hash of the bytes the origin sent that request, so a waiter only gets an encode of bytes identical to its own.
- **The time limit.** `timeoutMs` bounds how long one request waits. The late result is cached under its key, so a slow file costs the encoder once.
- **Widths.** The width of a conversion comes from a client hint, from the `spool-w` parameter or from `maxWidth`, and never exceeds 16384. With `images.responsive` the proxy honours `spool-w` only for a value in the fixed `widths` list and drops any other, so a visitor cannot make it encode an arbitrary size, and the keys one file can have are bounded by the widths, the three qualities and the PNG mode. The proxy removes `spool-w` before it forwards a request.

`video`, `lazy` and `responsive` edit start tags in text the origin already sent. They add no script. `video` changes no attribute value except `preload`, `lazy` adds `loading` and `decoding`, and `responsive` adds `srcset` and `sizes` built from the tag's own `src` and a fixed list of widths. A page rewritten because of `Save-Data` or `ECT` is made `private`, varied on both headers and declined, so one visitor's connection never becomes another's stored page. `tests/node/media.spec.ts` covers each rule.

## Embed Facades

`embeds` replaces a YouTube or Vimeo `<iframe>` with an iframe whose `srcdoc` is a link, so the player's requests wait for a click (`src/media/embeds.ts`). It never adds script to the page, and the document it writes runs none.

- **Escaping.** Every attribute value the facade copies, the title and the link are escaped for `&`, `<`, `>` and `"`. The video id has to match 6 to 64 of `A-Z a-z 0-9 - _`, and the link is rebuilt from the parsed embed URL with `autoplay=1`, never echoed from the source text.
- **What it keeps.** `sandbox` and `referrerpolicy` stay on the iframe, so the player a click loads runs under the restrictions the origin chose. `allow` and `allowfullscreen` stay too.
- **Content-Security-Policy.** The facade needs an inline style and, for YouTube, `i.ytimg.com` for the thumbnail, and the click needs the player host in `frame-src`. A response that sends the header is left alone and counted as `skipped.csp`. `ignoreCsp: true` takes the operator's word that the policy allows all three.
- **The thumbnail.** The visitor's browser asks `i.ytimg.com` for it without a click, which tells Google's image host about the visit and nothing else. `thumbnail: false` removes that request, and Vimeo's facade makes none.
- **Scripted players.** A URL with `enablejsapi=1` stays as it is, since the page's script expects the real player.
- **Ambient loops.** An embed that plays on its own by design stays as it is and counts as `skipped.ambient`: a URL with `background=1`, a URL with `autoplay=1` beside `mute=1`, `muted=1` or `loop=1`, and an iframe whose `class` or `id` holds the word hero, ambient, background or banner. A facade there would swap a decorative loop for a link.

`tests/node/media.spec.ts` covers each rule.

## Activity Hook

`window.spool.activity.register` is page code. It runs with the page's own privileges and holds only the `pause` and `resume` functions the site hands it, an optional element and a time. It reads no page content, stores nothing and sends nothing, and it never touches `setInterval`, `requestAnimationFrame`, `fetch`, audio, WebRTC or an element the site did not name. A function that throws is caught and reported once with `console.warn`, and the other loops go on. The worker is not involved, so the hook works without a service worker and adds nothing to the wire.

## Dictionary Transport

`dictionary` serves a stylesheet or script as the difference from an earlier file of the same directory that the visitor's browser holds (RFC 9842, `src/proxy/dictionary.ts`).

- **What becomes a dictionary.** Only a `GET` that the proxy would keep as a public page: no `Set-Cookie`, no `private` or `no-store`, no `Authorization`, whatever cookies the request carried. The dictionary is the origin's own earlier public bytes, so nothing personalised is ever eligible, and a visitor's request cannot make the proxy hold bytes it did not already serve to everyone.
- **What a visitor can name.** `Available-Dictionary` carries a SHA-256. The proxy looks it up among the public files it holds. Naming a hash tells the visitor nothing beyond whether the proxy holds content that any visitor could fetch, and a miss answers with the plain file.
- **Compression and secrets.** The input and the dictionary are both public static files, with no reflected request data and no cookie, so the length of an encoded answer reveals nothing a request could not read directly.
- **Caches.** An encoded answer carries `Vary: Accept-Encoding, Available-Dictionary`, so a shared cache does not hand it to a browser without the dictionary. The plain answer carries the same `Vary` and `Use-As-Dictionary`.
- **Cost.** The proxy keeps no encoded answers. Each request that names a held dictionary runs the `encoder`, whose cost belongs to the operator (a zstd level 19 encode of a large script takes seconds). Memory for dictionaries is bounded by `cacheBytes` and each body by `maxBytes`, and an encoder that throws or returns more bytes leaves the plain file.

`tests/node/dictionary.spec.ts` covers each rule.

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
- `ga4Sink({ debug: true })` posts to `/debug/mp/collect`. That endpoint validates a hit and does not record it (the comment at `src/server/ga4.ts:143`; the vendor's documentation was not read for this section). The sink reads the status code only and counts the batch as sent, and the worker then removes it from the queue. A `debug` sink on a live site loses its events without an error, so use it in tests only. A replay never targets that path: the GA4 collector is delivered through the sink, and `matchCollector` matches `/g/collect` only (`tests/node/collectors.spec.ts`).
- A collect hit with no event name, or with one the Measurement Protocol pattern rejects, is held and handed to the sink. The sink sends nothing for it and counts nothing (`eventsOf`, `ga4Requests`, `tests/node/collectors.spec.ts`). A site that needs those hits counted has to count them in its own tag.
- In WebKit a cross-origin `@font-face` font costs one request per local view, because the worker does not answer that request there. `tests/browser/p6.pw.ts` leaves the font out of its WebKit checks (`fontless`). A run that logged the requests counted 3 font requests to the font origin across 3 local views and none for the versioned script (Playwright WebKit, 2026-11-15). The cause is not read from WebKit's source, and whether a same-origin font avoids the request in WebKit is not tested.

## What Spool Never Does

- **Authorise on the client.** The device holds only what the server already sent that principal. The worker has no access rule and no way to grant one.
- **Fabricate analytics.** The events spool writes itself are its own records: `spool.view`, `spool.loads` and the drop counts, which go to the `sink`. A vendor receives the body the page sent. Spool creates no vendor event. The page's immediate answer to a held request is the one thing it makes up, and it is stated above.
- **Replay programmatic ads.** The worker ignores every cross-origin request that matches no `collectors` entry and no `thirdParty.allow` origin (`classify`, `src/sw/router.ts`), and the browser handles those as it always did. Spool has no ad-specific code and no check against an operator listing an ad host.
- **Write on its own.** The application owns every write. `spool.invalidate` announces one. With the declared writes flag on, the worker queues and replays a write only for a class the site declared, and the server still decides whether it applies (see "Declared Writes"). The flag ships off.
- **Infer dependencies from opaque HTML.** A route names its tags, or the origin names them in cache tag headers.

## Open Limitations

Each limitation is stated in the section it belongs to. This table lists them in one place.

| Limitation                                                                                                                                                                                                                               | Section                                                                                |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| A sign-in whose response the worker sees without the new `Spool-Partition` leaves the previous partition readable until the first required sync, which is no later than `maxStale` plus the next view                                    | [The Open Window](#the-open-window)                                                    |
| A revoked permission shows for up to `maxStale`, nothing pushes a revocation, and `offline: 'serve'` shows a page past the bound                                                                                                         | [Revocation](#revocation)                                                              |
| Tag names and the write rate are readable by anyone through `/.spool/sync`                                                                                                                                                               | [Sync Tag Names](#sync-tag-names)                                                      |
| A sealed row is bound to its place and not to a version, so a row can be rolled back                                                                                                                                                     | [Sealed Stores](#sealed-stores)                                                        |
| `persistent` retention keeps the key in the same profile as the ciphertext                                                                                                                                                               | [Sealed Stores](#sealed-stores)                                                        |
| The seal gives no protection against script on the origin                                                                                                                                                                                | [Script on the Origin](#script-on-the-origin)                                          |
| A policy with a nonce chosen for each response does not match markup the worker renders, so its inline scripts fail on a local view                                                                                                      | [Content Security Policy](#content-security-policy)                                    |
| Assembly slots and fragments are not escaped                                                                                                                                                                                             | [Script on the Origin](#script-on-the-origin)                                          |
| A logout leaves the public replica, held cross-origin and spool events and Cache entries in place                                                                                                                                        | [Logout and the Wipe Order](#logout-and-the-wipe-order)                                |
| A held same-origin beacon replays under the next session when a sign-in names no partition and the next flush carries the browser cookies                                                                                                | [Logout and the Wipe Order](#logout-and-the-wipe-order)                                |
| A `logout` pattern matches any method, so a `GET` wipes the local principal store                                                                                                                                                        | [Logout and the Wipe Order](#logout-and-the-wipe-order)                                |
| Proxy mode cannot tell a rolling session cookie from a login, and a cookie set outside the proxy produces no clear                                                                                                                       | [Cookies in Proxy Mode](#cookies-in-proxy-mode)                                        |
| `/.spool/beacon`, `/.spool/sync` and `/.spool/artifact` need no credentials and have no rate limit, and a flush can ask the server to build 8 artifacts and a catalogue of up to 32 pages                                                | [Endpoints That Need No Credentials](#endpoints-that-need-no-credentials)              |
| A catalogue request names the path of the page the visitor is on, including a page the worker showed locally, which no other request or view event carries                                                                               | [Catalogue Entries](#catalogue-entries)                                                |
| An unopened principal catalogue entry stays on the device until a required principal sync names its tags, the visitor returns, or the partition is wiped                                                                                 | [Catalogue Entries](#catalogue-entries)                                                |
| A trimmed stylesheet can lose a rule for a class that a later vendor script, late-injected markup or a runtime-built class name needs, which the guard cannot see                                                                        | [Trimmed Stylesheets](#trimmed-stylesheets)                                            |
| A same-origin stylesheet linked with an `integrity` attribute fails the browser's hash check under `trim` on every page the guard does not rewrite, so its rules do not load                                                             | [Trimmed Stylesheets](#trimmed-stylesheets)                                            |
| The purge endpoint has no rate limit or lockout, and any holder of the secret can bump any tag                                                                                                                                           | [Purge Endpoint](#purge-endpoint)                                                      |
| In WebKit a cross-origin `@font-face` font costs one request per local view, since the worker does not answer it there                                                                                                                   | [Analytics and Third Parties](#analytics-and-third-parties)                            |
| `ga4Sink` with `debug: true` posts to the validation endpoint, which records nothing, so the batch counts as sent                                                                                                                        | [Analytics and Third Parties](#analytics-and-third-parties)                            |
| In shadow mode a non-200 network answer is neither read nor cancelled, so its copy buffers the body until the copy is collected                                                                                                          | [Shadow Mode](#shadow-mode)                                                            |
| The `importScripts` form of the worker has no integrity check                                                                                                                                                                            | [Script Delivery](#script-delivery)                                                    |
| `Clear-Site-Data` support in Safari is unverified                                                                                                                                                                                        | [Clear-Site-Data](#clear-site-data)                                                    |
| The secrets, the partition secret and the purge secret, have no enforced minimum length                                                                                                                                                  | [Partitions and the HMAC](#partitions-and-the-hmac), [Purge Endpoint](#purge-endpoint) |
| A principal route cannot declare `query.plan`                                                                                                                                                                                            | [Principal Datasets](#principal-datasets)                                              |
| Joins that read a principal dataset are not supported: a principal route has no plan, and a plan join must match its route's scope                                                                                                       | [Principal Datasets](#principal-datasets)                                              |
| A worker without partition storage drops nothing on a partition change (from the code, not tested)                                                                                                                                       | [The Open Window](#the-open-window)                                                    |
| Declared writes and principal datasets have no switch except their `createSpool` flags, which need a redeploy. Turning a flag off leaves queued writes and held rows on the device until a logout, a `Spool-Clear` or a partition change | [Declared Writes](#declared-writes), [Principal Datasets](#principal-datasets)         |
| A site with more than one instance needs `apply` to store `ctx.writeId`, or a retry that lands on another instance reads as a conflict. No test covers that case                                                                         | [Declared Writes](#declared-writes)                                                    |

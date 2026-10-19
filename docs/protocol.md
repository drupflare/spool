# Wire Protocol

This page describes what the server half and the worker send each other: paths, headers, JSON bodies and limits. It is written for someone who writes an adapter or a second server. The reference implementation is `src/protocol` (types, parsers and codecs both halves share), `src/server` (`createSpool`) and `src/sw` (the worker). Each value below carries the name the source gives it and the file that holds it. [security.md](security.md) covers the threat model and [impact.md](impact.md) covers the energy figures.

`tests/node/docs.spec.ts` reads this page and fails when a header, a path, a `MAX_*` constant or a protocol constant in `src/protocol/index.ts` differs from the tables here.

## Conventions

- Every JSON body carries `protocol`, an integer. `PROTOCOL_VERSION` is `1` (`src/protocol/artifact.ts`).
- Header names are case-insensitive. `HEADERS` holds them in lowercase and this page writes them in Title Case in prose.
- A header or query integer matches `^\d{1,15}$`: decimal digits only, 15 at most.
- Tags and artifact ids are opaque strings. An artifact id is the request path it answers, so it starts with `/`.
- A tag is a dependency name such as `node:1`. A tag's version is the vector cursor at its last change.
- Every JSON answer from the server half is `Content-Type: application/json` with `Cache-Control: no-store`. A principal artifact answers `private, no-store`.
- A refusal is `{"error": "<message>"}`. A `ProtocolError` (`src/protocol/errors.ts`) answers `400` with its message. Any other exception answers `500` with `{"error":"internal error"}` and no detail.

## Paths

`PATHS` (`src/protocol/config.ts`) names the four paths a server half owns.

| `PATHS` key | Path               | Methods   | Answered by                                         |
| ----------- | ------------------ | --------- | --------------------------------------------------- |
| `sync`      | `/.spool/sync`     | GET, HEAD | `respondSync`, `src/server/sync.ts`                 |
| `artifact`  | `/.spool/artifact` | GET, HEAD | `respondArtifact`, `src/server/spool.ts`            |
| `beacon`    | `/.spool/beacon`   | POST      | `respondBeacon`, `src/server/beacon.ts`             |
| `worker`    | `/spool-sw.js`     | GET       | `spool.stub()`; `handle` routes it, an adapter does |

Two more paths are not in `PATHS`.

| Path                          | Methods   | Answered by                                                               |
| ----------------------------- | --------- | ------------------------------------------------------------------------- |
| `/.spool/<version>/client.js` | GET, HEAD | `clientPath(VERSION)` in `src/protocol/config.ts`, answered in `answer()` |
| `/.spool/purge`               | POST      | `PURGE_PATH` in `src/proxy/purge.ts`; proxy mode only                     |

`SPOOL_PREFIX` is `/.spool/`. Every path under it belongs to spool. `createSpool` refuses a `beacons` or `logout` entry under it. A request under the prefix that no row above claims answers `404` with `{"error":"not found"}`, and so does a method a row does not list. The exceptions are `/.spool/beacon` and, in proxy mode, `/.spool/purge`: both answer `405` with `Allow: POST`.

### Worker Script

`/spool-sw.js` answers `200` with `Content-Type: text/javascript; charset=utf-8`, `Cache-Control: max-age=86400` and `Service-Worker-Allowed: /` (`workerResponse`, `src/server/stub.ts`). The body is `self.__SPOOL_CONFIG__=<SwConfig as JSON>;`, a newline, then the worker core, or the site's own bundle when `createSpool` gets `worker`. `SwConfig` is in `src/protocol/config.ts`. The page registers the script with `updateViaCache: 'all'`, and the day-long `max-age` is what lets Chromium and Firefox skip the update check for a controlled navigation. A deploy changes the bytes and reaches a browser within that day.

### Page Runtime Script

`/.spool/<version>/client.js` answers `200` with the page runtime, `Content-Type: text/javascript; charset=utf-8` and `Cache-Control: public, max-age=31536000, immutable`. `<version>` is `VERSION` (`src/version.ts`) percent-encoded. A different version answers `404`. A server that serves the script from a CDN passes `cdn` to `createSpool`, and the tag then names that URL.

### Client Tag

`decorate` puts one script tag in each HTML page: `<script src="<url>" defer data-spool-client></script>`, plus `integrity="<hash>" crossorigin="anonymous"` when `cdn` is set (`clientTag`, `src/protocol/tag.ts`). `SwConfig.clientTag` holds the exact string. `injectClientTag` puts it before `</head>`, else before `</body>`, else at the end, and leaves a page that already contains `data-spool-client` alone. The worker injects the same string into every page it renders, so a local render and a network render are equal after `normalise`. A second server must inject the identical string at the same place, or shadow mode reports a mismatch on every page.

`decorate` injects only into a `GET` answered `200` as `text/html` with no `Content-Encoding`. When it changes the body it deletes `Content-Length` and weakens a strong `ETag` to `W/<etag>`.

## Headers

`HEADERS` is in `src/protocol/envelope.ts`. `encodeEnvelope`, `writeEnvelope` and `decodeEnvelope` are its codec.

| `HEADERS` key | Header              | Sent by                                        | Value                                                  |
| ------------- | ------------------- | ---------------------------------------------- | ------------------------------------------------------ |
| `protocol`    | `spool-protocol`    | server, on every spool response                | integer, `1`                                           |
| `artifact`    | `spool-artifact`    | server, on a response the worker may keep      | `id=<id>; scope=<scope>; deps=<tag>,<tag>; v=<cursor>` |
| `invalidate`  | `spool-invalidate`  | server                                         | `<tag>=<version>, <tag>=<version>`                     |
| `clear`       | `spool-clear`       | server                                         | `*`, or partition ids separated by commas              |
| `vector`      | `spool-vector`      | server                                         | integer cursor                                         |
| `partition`   | `spool-partition`   | server, and on `/.spool/sync` with an identity | token matching `^[A-Za-z0-9_-]{1,128}$`                |
| `vectorSeen`  | `spool-vector-seen` | worker on requests, server on responses        | integer cursor                                         |
| `provision`   | `spool-provision`   | server, on a `204` from `/.spool/artifact`     | `declined`                                             |

`Spool-Vector-Seen` is the one spool header a request carries. On a request it is the cursor the worker holds. On a response it echoes that value, which says the `Spool-Invalidate` beside it is the complete diff since that cursor. The worker sends it on a same-origin `GET` that is not a navigation, when it holds a cursor and has no manifest (`passthrough`, `src/sw/runtime.ts`). The proxy deletes every `spool-` request header before it forwards a request.

`Spool-Provision` is set by `respondArtifact` directly and is not part of the `Envelope` type.

### Field Grammar

| Header             | Grammar                                                                                                                                                                                                                                             |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `spool-artifact`   | fields split on `;`, each `name=value` with a name at least one character long. `id` and `v` are required. `scope` is `public` or `principal`. `id` and each `deps` entry are percent-encoded. Unknown field names are ignored. `deps` is optional. |
| `spool-invalidate` | entries split on `,`. Each entry splits at its last `=`. The tag is percent-encoded and the version is an integer.                                                                                                                                  |
| `spool-clear`      | tokens split on `,`, each percent-encoded. `*` is `CLEAR_ALL`.                                                                                                                                                                                      |

`decodeEnvelope` treats an absent header as an absent field and throws `ProtocolError` with code `bad-header` on a malformed one. The worker reads a response through `decodeEnvelopeOrClear`. When `decodeEnvelope` throws, the worker ignores every spool header of that response except `Spool-Clear`, which it reads on its own. A valid `Spool-Clear` still applies, a malformed one counts as `*`, and a response whose `Spool-Protocol` names another version is ignored. `encodeEnvelope` refuses a `partition` that does not match the pattern.

Examples from `encodeEnvelope`, the first for the artifact of `/node/3` at cursor 1 with the tag `node:3`, the second for a response to `Spool-Vector-Seen: 1` when the cursor is 2 and only `b` changed (`tests/unit/server.spec.ts`):

```text
Spool-Protocol: 1
Spool-Artifact: id=%2Fnode%2F3; scope=public; deps=node%3A3; v=1
```

```text
Spool-Protocol: 1
Spool-Invalidate: b=2
Spool-Vector: 2
Spool-Vector-Seen: 1
Vary: Spool-Vector-Seen
```

### Other Headers

| Header                       | Set by                                                 | Meaning                                                        |
| ---------------------------- | ------------------------------------------------------ | -------------------------------------------------------------- |
| `X-Spool-Route`              | `decorate`, on a routed `GET` or `HEAD` answered `200` | the route pattern that matched                                 |
| `X-Spool-Mode`               | `decorate`, with `X-Spool-Route`                       | `serve` or `shadow`                                            |
| `Vary: Spool-Vector-Seen`    | `decorate`, on a read that sent `Spool-Vector-Seen`    | keeps a shared cache from replaying one diff to another cursor |
| `Clear-Site-Data: "storage"` | `decorate`, when called with `hardReset: true`         | the browser's own reset of everything the origin holds         |
| `Service-Worker-Allowed: /`  | `workerResponse`                                       | lets the worker control the whole origin                       |

### Security Headers

A page the worker renders from an artifact has no network response of its own, so the worker replays headers of the network responses it saw. `POLICY_HEADERS` (`src/sw/policy.ts`) is the list: `Content-Security-Policy`, `Content-Security-Policy-Report-Only`, `X-Frame-Options`, `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`, `Cross-Origin-Opener-Policy`, `Cross-Origin-Embedder-Policy` and `Cross-Origin-Resource-Policy`. A server half sends nothing new for this: the application's own headers are the source.

- The worker stores the set from a `200` HTML navigation to a route's path with no query string and from a `200` `data` read, under that path. Any `200` same-origin HTML navigation also replaces the site-wide set.
- A local render replays the path's own set, or the site-wide set when the path has none. With neither, the worker leaves the view to the network.
- `static` routes replay all the headers they stored instead. The sets are persisted with the replica and removed with it.

[security.md](security.md#content-security-policy) states the consequences.

## The Envelope

`Envelope` (`src/protocol/envelope.ts`) is every spool header of a response, decoded.

| Field        | Header              | Type                           | Meaning                                                                                   |
| ------------ | ------------------- | ------------------------------ | ----------------------------------------------------------------------------------------- |
| `protocol`   | `spool-protocol`    | integer                        | the protocol version the sender speaks                                                    |
| `artifact`   | `spool-artifact`    | `{ id, scope, deps, version }` | this response is the artifact for `id` at cursor `version`, built from the tags in `deps` |
| `invalidate` | `spool-invalidate`  | tag to version                 | tags that changed, each with the cursor at its last change                                |
| `clear`      | `spool-clear`       | list of strings                | partition ids to wipe, or `*` for everything                                              |
| `vector`     | `spool-vector`      | integer                        | the server's cursor                                                                       |
| `seen`       | `spool-vector-seen` | integer                        | echo of the request's cursor; `invalidate` is the complete diff since it                  |
| `partition`  | `spool-partition`   | string                         | the partition the response belongs to                                                     |

### What decorate Sends

`decorate` (`src/server/spool.ts`) adds these by case. `MAX_PIGGYBACK` is `32` and is described under [Limits](#limits).

| Case                                                                                                   | Headers added                                                                                                                                                                   |
| ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| any response except status `101`, which is returned untouched                                          | `Spool-Protocol: 1` and `Spool-Vector` with the cursor read before the application ran, unless a row below removes it                                                           |
| `GET` or `HEAD` with `Spool-Vector-Seen: n`, `n` at most the cursor, changes at most 32                | `Spool-Invalidate` with every changed tag (omitted when none changed), `Spool-Vector` with the cursor, `Spool-Vector-Seen: n`                                                   |
| the same, with more than 32 changed tags                                                               | `Spool-Protocol` only. The worker takes nothing from it and asks `/.spool/sync` later                                                                                           |
| the same, with `n` ahead of the cursor                                                                 | `Spool-Clear: *`, `Spool-Vector` with the cursor, `Spool-Vector-Seen: n`                                                                                                        |
| the same, with `n` not an integer                                                                      | `Spool-Protocol` only                                                                                                                                                           |
| any method but `GET` and `HEAD`                                                                        | `Spool-Vector` with the cursor after the write. The tags the write changed ride in `Spool-Invalidate`; more than 32 changed, or a vector that was reset, sends `Spool-Clear: *` |
| `clear` option                                                                                         | `Spool-Clear` with those tokens, replacing any value the rows above set                                                                                                         |
| identity resolves and the response has no `Spool-Partition`                                            | `Spool-Partition` for that principal                                                                                                                                            |
| routed `GET` or `HEAD` answered `200`, HTML or a `static` or `data` route, public or identity resolves | `Spool-Artifact` with `version` set to the cursor read before the application ran                                                                                               |

The cursor is read before the application runs, so a write that races a render leaves the artifact looking older than the write, which makes the worker refetch it. `handle` reads the cursor first and passes it to `decorate`.

A page the proxy declines can still tell the worker to drop its copy: the proxy writes `Spool-Invalidate` with the tag `spool:artifact:<path>` at a version one past the cursor. The version is not recorded in the vector.

### How the Worker Reads an Envelope

The worker (`early` and `observe` in `src/sw/runtime.ts`, `applyEnvelope` in `src/sw/replica.ts`) applies a response's spool headers only when `Spool-Protocol` equals `PROTOCOL_VERSION`. Any other value, or none, makes the response an ordinary one.

- `Spool-Clear` with `*` empties the replica and sets the cursor to `Spool-Vector` when present.
- `Spool-Invalidate` raises tag versions. It always applies.
- The cursor and the sync clock advance only when the response carries `Spool-Vector-Seen` equal to the value the worker sent, carries `Spool-Vector`, and has no `Age` header. A copy a shared cache replays cannot extend freshness.
- `Spool-Artifact` on a navigation (or on a `data` route read) makes the worker fetch `/.spool/artifact?path=<id>` when it holds no artifact for `id`, has not been told to leave that path to the network (a `204` declined), the route matches, the strategy is not `static` and the scope matches. For a `static` route the worker keeps the response itself, bytes and headers, when the advertised id equals the path and the scope is `public`.
- A principal artifact is fetched only when the response's `Spool-Partition` equals the partition the worker holds.
- A `/.spool/sync` answer is read the same way before the worker uses it (`fetchSync`, `src/sw/runtime.ts`). A `Spool-Partition` that differs from the held partition swaps the store, and an answer with none wipes the principal store as a session that ended. A sync answer therefore ends a sign-in or sign-out the worker never saw.
- A response's security headers are not part of the envelope, and the worker keeps them as well. See [Security Headers](#security-headers).

## Version Vector

The version vector is the server's record of change (`VersionVector`, `src/protocol/vector.ts`). A store behind it implements `VersionStore` (`src/stores/version-store.ts`): `bump(tags)`, `cursor()` and `diff(from)`.

- The cursor starts at `0` and only moves forward. `bump` moves it by exactly one, whatever the number of tags, and stamps each tag with the new value. `bump([])` changes nothing.
- A tag's version is the cursor at its last change, and `0` when it never changed.
- `diff(from)` is every tag whose version is above `from`, with the current cursor. When `from` is above the cursor, the holder has lost its server (a restart that forgot state, a different deployment), and the diff has `reset: true` and every tag. The holder wipes what it holds.
- A store must keep the cursor monotonic across restarts. `memoryStore` begins at `0` on every start unless it is given a snapshot, so after a restart every worker holding a higher cursor is told to reset. `SpoolVersions` (`src/stores/durable-object.ts`) keeps one SQLite row per tag and one cursor row.
- An artifact's `vector` is the cursor read before the artifact was built. The worker keeps an artifact while no tag in its `deps` has a version above that `vector` (`isCurrent`, `src/sw/freshness.ts`).
- The worker's copy only moves forward. A tag version is raised only by a higher value, the cursor takes the maximum, and a copy built before a change it already knows of is refused at `put`.
- An artifact can be dropped by id. `spool.invalidate(tags, { drop })` bumps the tag `spool:artifact:<id>` (`ARTIFACT_TAG_PREFIX`, `artifactTag`, `src/protocol/sync.ts`). The sync answer lists such ids in `dropped` and does not list the tag in `changed`.

`VersionVector.from(snapshot)` accepts a cursor that is a non-negative safe integer and tag versions from `1` to the cursor.

Example, from `tests/unit/wire.spec.ts`. After `bump(['node:1', artifactTag('/page')])`, `toSyncResponse(diff(0))` is:

```json
{
  "protocol": 1,
  "cursor": 1,
  "changed": { "node:1": 1 },
  "dropped": ["/page"],
  "reset": false
}
```

## Sync

`GET /.spool/sync` answers what changed. Two forms exist, `from` and `need`. `need` wins when both are present.

### Sync by Cursor

`?from=<n>` takes the worker's cursor. Any other value, or none, answers `400` with `from must be a non-negative integer`. The answer is a `SyncResponse` (`src/protocol/sync.ts`):

| Field      | Type            | Meaning                                                                     |
| ---------- | --------------- | --------------------------------------------------------------------------- |
| `protocol` | `1`             |                                                                             |
| `cursor`   | integer         | the server's cursor; the holder takes it                                    |
| `changed`  | tag to integer  | every tag whose version is above `from`, without the `spool:artifact:` tags |
| `dropped`  | list of strings | artifact ids the server dropped after `from`                                |
| `reset`    | boolean         | `from` is ahead of the cursor: wipe everything held, then take `cursor`     |
| `partial`  | boolean         | present and `true` only in a `need` answer                                  |

The headers are `Spool-Protocol: 1` and `Spool-Vector: <cursor>`. When `createSpool` has an `identity` option, the answer also carries `Spool-Partition` for the identity the request's cookies resolve to, and carries none when they resolve to nobody. The worker applies it as it does on a navigation, and a server without an `identity` option sends none. Example, from `tests/unit/server.spec.ts`, after `invalidate(['node:1', 'menu'])` and `invalidate(['node:2'], { drop: ['/page/x'] })`, for `GET /.spool/sync?from=1`:

```json
{
  "protocol": 1,
  "cursor": 2,
  "changed": { "node:2": 2 },
  "dropped": ["/page/x"],
  "reset": false
}
```

### Sync by Need

`?need=<held>` asks only about the ids the next page reads. `<held>` is `id@version` pairs joined by commas, with each id percent-encoded (`encodeHeld`, `parseHeld`, `src/protocol/sync.ts`). The worker sends every tag an artifact depends on, and the artifact's own `spool:artifact:<id>` tag, each at the artifact's `vector`. Parsing splits on `,`, ignores empty parts, takes the version after the last `@` and requires it to be an integer. More than `MAX_NEED` entries, or a malformed one, answers `400`. A worker whose artifact depends on more than `MAX_NEED` tags falls back to a full sync.

The answer has `partial: true`. `changed` holds only the asked-about tags whose version is above the version asked with. `dropped` holds the artifact ids whose drop tag passed it. The `cursor` in a partial answer is not the holder's to take, because the answer covers only part of the diff, and `applySync` leaves the cursor and the sync clock alone. `reset` is `true` when the highest version asked about is above the server's cursor, and `changed` is then empty. An empty `need=` answers the cursor alone, with `partial: true`.

Example, from `tests/unit/server.spec.ts`. After `invalidate(['a', 'b'])`, `invalidate(['c'], { drop: ['/page/x'] })` and `invalidate(['a'])`, the request carries this `need` before it is percent-encoded as a query value:

```text
a@1,b@1,c@3,d@0,spool%3Aartifact%3A%2Fpage%2Fx@1
```

The answer is `Spool-Vector: 3` and:

```json
{
  "protocol": 1,
  "cursor": 3,
  "changed": { "a": 3 },
  "dropped": ["/page/x"],
  "reset": false,
  "partial": true
}
```

`b` and `d` are absent because neither moved past the version asked, and `c` is absent because it was asked at `3`.

## Artifact

`GET /.spool/artifact?path=<path>[&have=<held>]` answers the artifact for a path. The request carries the visitor's cookies, so `identity.resolve` sees the visitor.

| Parameter | Meaning                                                                                                                                                         |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `path`    | a pathname that starts with `/`. Anything else answers `400` with `path must start with "/"`. The server matches it as given, so send no query string.          |
| `have`    | `id@version` pairs, in the format of `need`, for the records and projections the worker holds. More than `MAX_HAVE` entries, or a malformed one, answers `400`. |

The server picks the first route whose pattern matches. It reads the cursor, runs `depends` and `load`, collects the records and projections the load registered, validates the result with `parseArtifact`, and drops from `records` and `projections` whatever `have` already covers at a version no change has passed. When the holder claims a version from the future the server sends everything.

| Status | Body or headers                                                         | When                                                                                                                                |
| ------ | ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `200`  | an `Artifact`; `Spool-Protocol: 1`                                      | the route is public, or principal and the identity resolves                                                                         |
| `200`  | as above, plus `Spool-Partition` and `Cache-Control: private, no-store` | a principal route                                                                                                                   |
| `204`  | `Spool-Provision: declined`, `Cache-Control: no-store`                  | the public artifact costs more than its expected reuse repays; see [Provisioning](#provisioning)                                    |
| `400`  | `{"error": <message>}`                                                  | bad `path` or `have`; a `$record` or `$projection` reference the load did not register; a built artifact that fails `parseArtifact` |
| `401`  | `{"error":"sign in"}`                                                   | a principal route and no identity                                                                                                   |
| `404`  | `{"error":"no route"}`                                                  | no pattern matches                                                                                                                  |
| `404`  | `{"error":"a static route is not provisioned"}`                         | the route's strategy is `static`                                                                                                    |
| `500`  | `{"error":"internal error"}`                                            | `load` threw something other than a `ProtocolError`                                                                                 |

### The Artifact Body

`Artifact` (`src/protocol/artifact.ts`) is `protocol`, `id`, `scope`, `deps`, `vector`, optional `records` and `projections`, `strategy` and `body`. `parseArtifact` is what the worker calls before it stores anything.

| Field         | Rule                                                                                                                                                   |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `protocol`    | must equal `PROTOCOL_VERSION`                                                                                                                          |
| `id`          | a string that starts with `/`                                                                                                                          |
| `scope`       | `public` or `principal`                                                                                                                                |
| `deps`        | a list of strings: the route's `depends` result, plus every record id and every projection dependency                                                  |
| `vector`      | a non-negative safe integer: the cursor read before the artifact was built                                                                             |
| `strategy`    | `template`, `projection`, `data` or `assembly`                                                                                                         |
| `body`        | for `template`, `projection` and `data`, `{ "data": <any JSON> }`. For `assembly`, `{ "shell": <string>, "fragments"?: <object>, "slots"?: <object> }` |
| `records`     | optional list of `{ id, version, data }`, each `id` a non-empty string and `version` a non-negative integer                                            |
| `projections` | optional list of `{ id, version, deps, data }`, each `deps` a list of strings                                                                          |

`parseArtifact` refuses a `static` artifact and any other strategy with `bad-artifact`. A static artifact exists only inside the worker, which builds it from a response it fetched, and `/.spool/artifact` answers `404` for a static route.

A page's data refers to a record with `{"$record": "<id>"}` and to a projection with `{"$projection": "<id>"}`. A reference is an object with that one key. The worker replaces each reference with the stored value when it renders, and refuses to render a page whose reference has nothing behind it. A projection that reaches itself is refused. An assembly `fragments` or `slots` value is either a string or a reference.

An assembly shell holds a hole as `<span data-spool-placeholder="<id>"></span>` (`placeholder`) and a named value as `{{spool-slot:<name>}}` (`slot`, names match `[A-Za-z0-9_.-]+`), both in `src/protocol/assembly.ts`. The worker refuses to render a shell with an unfilled hole or slot.

Example for a template route, built from the format `parseArtifact` accepts (the key order is the server's):

```json
{
  "protocol": 1,
  "id": "/c/101",
  "scope": "public",
  "deps": ["course:101"],
  "vector": 0,
  "records": [{ "id": "course:101", "version": 0, "data": "Intro" }],
  "strategy": "template",
  "body": { "data": { "title": { "$record": "course:101" } } }
}
```

The artifact answer for `/node/7` in `tests/unit/server.spec.ts` is the same shape without `records`: `deps` is `["node:7"]` and `body` is `{ "data": { "id": "7" } }`.

## Beacon

`POST /.spool/beacon` takes the events the worker held, in one body, and answers with artifacts when the worker asked for some.

### The Batch

`BeaconBatch` (`src/protocol/beacon.ts`) is `{ protocol, events, want? }`. `parseBeaconBatch` validates it.

| Field    | Rule                                                                                          |
| -------- | --------------------------------------------------------------------------------------------- |
| `events` | a list of at most `MAX_BEACON_EVENTS` events                                                  |
| `want`   | optional list of at most `MAX_WANT` strings, each starting with `/`; artifact paths to answer |

`BeaconEvent` fields:

| Field         | Rule                                                                                       |
| ------------- | ------------------------------------------------------------------------------------------ |
| `path`        | a string that starts with `/`                                                              |
| `body`        | a string                                                                                   |
| `contentType` | a string                                                                                   |
| `at`          | a finite number: epoch milliseconds on the device                                          |
| `search`      | optional string: the original query string with its `?`                                    |
| `method`      | optional, only `GET`; absent means `POST`                                                  |
| `origin`      | optional string: the origin of a held cross-origin request                                 |
| `vendor`      | optional string: the collector entry that matched                                          |
| `deliver`     | optional, only `sink`: the worker did not replay the event, so the server half forwards it |

The worker also keeps an `until` field on a held event, the time after which it drops the event. It removes `until` before it sends a batch, and `parseBeaconBatch` does not read it.

Example, from `tests/unit/server.spec.ts`. The server hands the events to the `sink` and answers `204` with `Cache-Control: no-store`:

```json
{
  "protocol": 1,
  "events": [
    { "path": "/cdn-cgi/rum", "body": "{\"a\":1}", "contentType": "application/json", "at": 5 }
  ]
}
```

### What Travels in a Batch

`OWN_PREFIX` is `/.spool/`. An event whose path is under it, and an event with `deliver: "sink"`, travel in the batch. The worker replays every other held request to the URL the page meant, with its method, content type, query and body, and does not put it in a batch. Three paths under the prefix are events and not endpoints:

| Constant       | Path              | Body                                                                                       |
| -------------- | ----------------- | ------------------------------------------------------------------------------------------ |
| `VIEW_PATH`    | `/.spool/view`    | a `ViewEvent`, JSON; see [View Events](#view-events)                                       |
| `LOADS_PATH`   | `/.spool/loads`   | `{ view, count, origins? }`, JSON; the page's report of cross-origin loads for view `view` |
| `DROPPED_PATH` | `/.spool/dropped` | `{ vendor, count }`, JSON; events the worker dropped past a vendor's age cap               |

A loads report is valid when `view` is a non-empty string of at most 64 characters, `count` is a non-negative safe integer, `origins` has at most `MAX_LOAD_ORIGINS` entries, each name is at most 253 characters and each count is a safe integer of at least `1` (`loadsFromBeacon`, `src/protocol/view.ts`). The last report for a view wins.

### The Answer

The server refuses a request body longer than `MAX_BEACON_BODY` characters with `413`, a body that is not JSON or a batch that does not validate with `400`, and any method but `POST` with `405` and `Allow: POST`. It writes the batch's events to the `sink`. A batch with `want` answers `200` with `{"protocol":1,"artifacts":[<Artifact>,...]}`: the public artifacts the server can build for those paths, in the order asked. A path that is principal, static, unrouted, declined by the provisioning rule or fails to build is left out. A batch without `want` answers `204`.

`MAX_BEACON_BYTES` bounds one event's body on the worker. A request body over it, or one whose content type is `octet-stream`, `multipart` or an `image/` type, goes to the network at once and is not held. `MAX_BEACON_BODY` bounds the whole request on the server. The first counts UTF-8 bytes and the second counts characters.

### When a Flush Happens

The worker flushes on a request that happens anyway (a "network moment") when a site's own beacon is held, artifacts are wanted, the oldest held event is an hour old, or 20 views are held. Held events alone leave on their own at most once every 24 hours, when the oldest is a day old. One request carries at most `FLUSH_CHUNK` events, and `want` rides the first chunk only. The constants are under [Limits](#limits). The server must accept a flush at any time and tolerate a batch of zero events.

### View Events

A view event is the JSON body of a `/.spool/view` event (`ViewEvent`, `src/protocol/view.ts`). `viewFromBeacon` accepts it only when every field validates.

| Field              | Type or values                                                  |
| ------------------ | --------------------------------------------------------------- |
| `id`               | string of 1 to 64 characters                                    |
| `tier`             | `local`, `local-revalidate`, `network`, `fallback` or `shadow`  |
| `reason`           | one of the reasons below                                        |
| `staleSec`         | number, or `null` when nothing was stored                       |
| `engine`           | `chromium`, `firefox`, `webkit` or `other`                      |
| `scope`            | `public` or `principal`                                         |
| `strategy`         | `assembly`, `template`, `static`, `projection` or `data`        |
| `route`            | the matched route pattern, at most `MAX_ROUTE_CHARS` characters |
| `mismatch`         | boolean, or `null` when no local render was made                |
| `swAgeMs`          | finite number: milliseconds since this worker instance started  |
| `gapMs`            | number, or `null` for the worker's first view                   |
| `crossOriginLoads` | non-negative integer, or `null` until the page reports          |

A view carries the route pattern and never the path, so a pattern such as `/node/:id` leaves the parameter out. `REASON_TIER` maps each reason to the tier a serving worker gives it. A shadow view keeps the reason and takes the tier `shadow`.

| Reason             | Tier               | Meaning                                                               |
| ------------------ | ------------------ | --------------------------------------------------------------------- |
| `cold`             | `network`          | nothing stored                                                        |
| `principal`        | `network`          | a principal route the worker cannot serve (it has no partition store) |
| `fresh`            | `local`            | within the bound                                                      |
| `soft-deferred`    | `local`            | past a soft bound, with the sync left for a network moment            |
| `soft-sync`        | `local-revalidate` | past a soft bound, with the sync sent now                             |
| `hard-sync`        | `local-revalidate` | past a hard bound, synced first                                       |
| `offline-stale`    | `local-revalidate` | past a hard bound with the network down, shown anyway                 |
| `invalidated`      | `fallback`         | a change outdated the stored copy                                     |
| `stale-after-sync` | `fallback`         | the sync made the stored copy stale                                   |
| `hard-refused`     | `fallback`         | a hard route offline with `offline: 'refuse'`                         |
| `refused`          | `fallback`         | the worker declined to render the stored copy                         |

## Partitions and Clearing

A route with `scope: 'principal'` is stored per partition. The server tells the worker which partition a response belongs to with `Spool-Partition`, and the worker keeps each partition in its own store.

- `Spool-Partition` is an opaque token matching `^[A-Za-z0-9_-]{1,128}$`. `partitionId` (`src/server/identity.ts`) is the reference derivation: HMAC-SHA-256 under the server secret over `spool-partition:1`, a NUL byte and the principal, base64url without padding, which is 43 characters. The worker never recomputes it and compares tokens for equality.
- A response whose `Spool-Partition` differs from the one the worker holds replaces the store. The old partition is destroyed first.
- A navigation whose response carries spool headers and no `Spool-Partition` ends the session when the worker holds a principal partition: it wipes the principal store (`session-ended`). A response with no spool headers at all changes nothing.
- `Spool-Clear: *` wipes the principal store and the public replica. `Spool-Clear: <partition id>` wipes that partition when it is the one held, and leaves the public replica alone.
- `SwConfig.logout` lists patterns (the [route pattern language](#route-patterns)). A same-origin request whose path matches one, with any method, wipes the principal store when it reaches the worker, before the request is sent and after the worker has sent the held same-origin beacons or dropped them. The answer to that request cannot bring a partition back, even though it still names one.
- Each wipe broadcasts `{ "type": "spool:cleared", "reason": "<reason>" }` to every page of the origin. Reasons are `clear`, `partition`, `logout` and `session-ended`. The page runtime turns it into a `spool:cleared` event on `window`.
- `Clear-Site-Data: "storage"` is a browser feature and not part of the worker's logic. The server sends it when `decorate` is called with `hardReset: true`.

An application that logs a visitor in or switches accounts sets `Spool-Partition` on its own response with `spool.partition(principal)`. The request that response answers still carries the previous identity, so `decorate` alone would name the previous partition. [security.md](security.md) covers the window this leaves open when the application does not.

## Provisioning

The server decides whether a public artifact is worth sending, and answers `204` with `Spool-Provision: declined` when it is not. The worker then leaves that path to the network until it restarts. The rule is `benefit` in `src/protocol/provision.ts`:

```text
reuse * futureViews * avoided - provision - maintain
```

Each term is in bytes, with a request counted as `requestBytes`. An artifact is sent when the result is positive. A `data` route weighs against its own size. Principal artifacts are not weighed.

`DEFAULT_PRIOR` (`src/protocol/provision.ts`) holds the scenario priors the worker and the server use until telemetry replaces them. Every one is an assumption. `ProvisionConfig` in `src/protocol/config.ts` overrides them, and a route's `provision` field overrides `reuse` and `futureViews` for that route.

| Field           | Default | Meaning                                                           |
| --------------- | ------- | ----------------------------------------------------------------- |
| `reuse`         | `0.5`   | the chance a provisioned artifact serves a later view             |
| `futureViews`   | `2`     | later views one provisioned artifact serves                       |
| `requestBytes`  | `2000`  | what one request weighs in bytes                                  |
| `artifactBytes` | `20000` | size of one artifact before the worker has fetched any            |
| `avoidedBytes`  | `17054` | bytes one local view keeps off the wire                           |
| `changesPerDay` | `1`     | how often one dependency tag changes, per day, before any is seen |

A flush that carries `want` also provisions: the worker asks for visited shadow-mode routes and for the `hot` list, best benefit first, at most `MAX_WANT` paths.

## Protocol Version Skew

Both halves speak `PROTOCOL_VERSION`, now `1`. The rule has four parts.

- The worker ignores the spool headers of a response whose `Spool-Protocol` differs from its own, and of a response that has none. The response is then an ordinary one.
- `parseArtifact`, `parseSyncResponse` and `parseBeaconBatch` refuse a body whose `protocol` differs. The server answers a refused batch with `400`. The worker counts a refused sync or artifact as a failed request, which a hard route with `offline: 'refuse'` answers by going to the network.
- A page's `spool:hello` message carries its protocol, and the worker answers `{ type, protocol, version, compatible }` with `compatible` false when they differ. `register` returns that answer as `hello`.
- `SwConfig.version` is the package version. When the version a replica stored differs from the running worker's, `load` empties what the old one stored, and asset caches from older versions are deleted on activation.

The protocol has no negotiation step. The two halves agree on the version or the worker treats the server as a plain origin.

## Route Patterns

`checkPattern`, `matchPattern` and `fillPattern` are in `src/protocol/pattern.ts`. The same language is used by routes, `logout` entries and manifest routes.

| Form    | Meaning                                                                                                  |
| ------- | -------------------------------------------------------------------------------------------------------- |
| `/a/b`  | literal segments, compared exactly and case-sensitively against the raw path segment                     |
| `:name` | captures one whole segment. The value is percent-decoded. An undecodable value makes the route not match |
| `**`    | only as the last segment. Matches zero or more segments after the prefix and captures nothing            |

The rules:

- A pattern starts with `/`.
- A trailing slash is ignored on the pattern and on the path, so `/a/` matches `/a`. The root is `/`.
- An empty segment (`//`) is refused.
- A parameter name matches `^[A-Za-z_][A-Za-z0-9_]*$` and appears once in a pattern.
- `/docs/**` matches `/docs` and `/docs/a/b`. `/**` matches every path, including `/`.
- Matching runs against the pathname. A query string and a fragment are not part of it.
- The first route in declaration order that matches wins.
- `fillPattern` is the inverse of `matchPattern` and refuses a pattern with `**`.

A bad pattern throws `ProtocolError` with code `bad-pattern`.

Examples from `matchPattern`: `/a/:b` matches `/a/x%20y` with `{ "b": "x y" }`, and does not match `/a/`. `/a//b`, `/**/a` and `/a/:b/:b` fail `checkPattern`.

## Query Strings

An artifact is keyed by path alone, so the worker never answers a navigation or a `data` read that has a query string (`classify`, `src/sw/router.ts`). A navigation with a query goes to the network. A `data` read with a query is handled as an ordinary subresource. A `static` route read as a subresource is matched on the pathname, and its file is stored under the pathname plus the query string: `/app.js?v=2` is a different file from `/app.js`, and a query string the worker has not stored goes to the network. On a server half the worker keeps only a response whose `Spool-Artifact` id equals that key, and the server advertises the pathname, so a queried URL is never kept there. With a static manifest the worker keeps the queried file under its own key once it has fetched it, and checks it against the route's `version` like any other. The proxy treats a request with a query string as ineligible and forwards it untouched.

## Freshness

Each route declares a `Freshness` (`src/protocol/route.ts`): `maxStale` in seconds and a mode.

| Scope       | `maxStale` | Mode   | Default `offline` | Defaults in         |
| ----------- | ---------- | ------ | ----------------- | ------------------- |
| `public`    | `900`      | `soft` | `serve`           | `DEFAULT_FRESHNESS` |
| `principal` | `300`      | `hard` | `refuse`          | `DEFAULT_FRESHNESS` |

`verdict` (`src/sw/freshness.ts`) compares the time since the artifact was last known good with `maxStale`. An artifact is last known good at its own fetch, at the last sync that covered it, or when `validate` recorded a confirming sync, whichever is latest. A clock that moved backwards counts as past the bound.

| Age                | Mode   | The worker does                                                                                                                                                                           |
| ------------------ | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| at most `maxStale` | either | shows the stored page, no request (`fresh`)                                                                                                                                               |
| past `maxStale`    | `hard` | syncs first and shows the page only if it is still current. A failed sync with `offline: 'refuse'` goes to the network, and with `offline: 'serve'` shows the page (`offline-stale`)      |
| past `maxStale`    | `soft` | shows the stored page at once and syncs once afterwards. A soft route with `sync: 'deferred'` queues the sync for the next network moment, and only when its expected benefit is positive |

A soft bound is a stale-while-revalidate window and promises nothing about how fresh the shown page is. A hard bound keeps a page from showing past `maxStale` unless a sync found it current, with one exception: a hard route whose `offline` is `serve` shows the stored page when the sync fails. A principal route syncs with `need` whatever its `sync` rule.

## Static Manifest

A site with no server half serves a `spool.json` beside `spool-sw.js`. `parseManifest` (`src/protocol/manifest.ts`) validates it, and the worker takes its routes from it. The worker makes no request to `/.spool/*` in this mode and sends no `Spool-Vector-Seen`.

| Field                | Rule                                                                                                                               |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `schema`             | must equal `MANIFEST_SCHEMA`, which is `1`                                                                                         |
| `routes`             | a list; a pattern declared twice is refused                                                                                        |
| `routes[].pattern`   | a [route pattern](#route-patterns)                                                                                                 |
| `routes[].strategy`  | must be `static`                                                                                                                   |
| `routes[].version`   | a string of 1 to `MAX_VERSION_CHARS` characters: `sha256-`, `sha384-` or `sha512-` plus a base64 digest, an entity tag, or a label |
| `routes[].freshness` | optional `{ maxStale, mode }`; `maxStale` a positive number, `mode` `hard` or `soft`                                               |
| `routes[].offline`   | optional, `serve` or `refuse`                                                                                                      |
| `routes[].sync`      | optional, `background` or `deferred`                                                                                               |

A digest version is checked against the bytes fetched, and a mismatch keeps nothing. An entity tag is checked against the response's `ETag`, ignoring a weak prefix. Any other string is a label the site chose and nothing checks it. The worker fetches the manifest with `cache: 'no-store'` and `credentials: 'same-origin'`, and a file whose version changed, or whose route left the manifest, is dropped. [README](../README.md) shows a manifest and the cap on file size.

## Page and Worker Messages

The page runtime and the worker talk over `postMessage` with a `MessageChannel` for replies (`createRuntime`, `src/sw/runtime.ts`; `register`, `src/client/register.ts`).

| Message           | Fields                      | Reply                                                                                      |
| ----------------- | --------------------------- | ------------------------------------------------------------------------------------------ |
| `spool:hello`     | `protocol`                  | `{ type, protocol, version, compatible }`                                                  |
| `spool:status`    |                             | `{ type, cursor, syncedAt, artifacts, beacons }`                                           |
| `spool:view`      | `path`                      | `{ type, id }`: the id of the latest view of that path, or `null`                          |
| `spool:loads`     | `view`, `count`, `origins?` | none; the worker queues a `/.spool/loads` event                                            |
| `spool:graph`     |                             | `{ type, records, projections }`: ids held                                                 |
| `spool:ledger`    |                             | `{ type, entries, totals }`: bytes and requests spent provisioning, against views served   |
| `spool:partition` |                             | `{ type, partition, artifacts, records, projections }`: ids held for the current partition |
| `spool:assets`    |                             | `{ type, mode, routed }`                                                                   |
| `spool:held`      |                             | `{ type, dropped, third }`: drops by vendor, and third-party URLs held                     |

The worker also posts `spool:cleared` to every page, as above. The replies list ids and counts, never stored content.

## Proxy Additions

`spoolProxy` (`src/proxy/proxy.ts`) answers the paths above and forwards everything else to an origin. It adds three things to the wire.

**Tag headers.** The origin names a page's dependencies in `Cache-Tag` (commas), `Surrogate-Key` and `X-Drupal-Cache-Tags` (spaces) or `xkey` (spaces or commas). `readTags` merges the four in first-seen order without repeats. The proxy removes them from the response unless `exposeTags` is set. A page with no tags depends on `proxy:path:<path>`.

**Forwarded requests.** The proxy sets `X-Forwarded-Host` and `X-Forwarded-Proto`, removes the hop-by-hop headers (`connection`, `keep-alive`, `proxy-authenticate`, `proxy-authorization`, `te`, `trailer`, `transfer-encoding`, `upgrade`, `host`) and every `spool-` header, sends redirects on with `redirect: 'manual'`, and answers `502` with `bad gateway` when the origin cannot be reached.

**Purge.** `POST /.spool/purge` bumps tags. It needs `Authorization: Bearer <purgeSecret>` and a JSON body `{"tags": [...]}` of 1 to 1000 distinct non-empty strings of at most 1024 characters, in a body of at most 65,536 characters. It answers `200` with `{"vector": <cursor>, "tags": <count>}`.

| Status | When                                                                                                                                  |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| `200`  | the tags were bumped; `tags` is the count after de-duplication                                                                        |
| `400`  | the body is not JSON, has no `tags` list, has no tags or more than 1000, or has a tag that is empty, not a string or longer than 1024 |
| `401`  | no `Bearer` credential, or the wrong one; `WWW-Authenticate: Bearer`                                                                  |
| `403`  | no `purgeSecret` is configured; every call is refused                                                                                 |
| `405`  | any method but `POST`; `Allow: POST`                                                                                                  |
| `413`  | `Content-Length` or the body is over 65,536 characters                                                                                |

The proxy also forgets the remembered body of every page that carries a purged tag, so the next fetch records the page afresh and one edit bumps the vector once.

## Limits

Every constant exported from `src/protocol/index.ts` whose name begins `MAX_` is in the first table. `tests/node/docs.spec.ts` compares the value column with the source.

| Constant            | Value  | Defined in                 | What it bounds                             |
| ------------------- | ------ | -------------------------- | ------------------------------------------ |
| `MAX_NEED`          | 64     | `src/protocol/sync.ts`     | ids in one `need` request                  |
| `MAX_HAVE`          | 256    | `src/protocol/sync.ts`     | ids in one `have` list                     |
| `MAX_BEACON_BYTES`  | 65,536 | `src/protocol/beacon.ts`   | UTF-8 bytes in one held event body         |
| `MAX_BEACON_EVENTS` | 500    | `src/protocol/beacon.ts`   | events in one batch                        |
| `MAX_WANT`          | 8      | `src/protocol/beacon.ts`   | artifact paths one flush may ask for       |
| `MAX_VERSION_CHARS` | 256    | `src/protocol/manifest.ts` | characters in a manifest route's `version` |
| `MAX_ROUTE_CHARS`   | 256    | `src/protocol/view.ts`     | characters in the route pattern of a view  |
| `MAX_LOAD_ORIGINS`  | 32     | `src/protocol/view.ts`     | origins one loads report names             |

The other protocol constants:

| Constant              | Value               | Defined in                  | Meaning                                                           |
| --------------------- | ------------------- | --------------------------- | ----------------------------------------------------------------- |
| `PROTOCOL_VERSION`    | 1                   | `src/protocol/artifact.ts`  | the protocol version both halves speak                            |
| `MANIFEST_SCHEMA`     | 1                   | `src/protocol/manifest.ts`  | the schema number of a `spool.json`                               |
| `SPOOL_PREFIX`        | `/.spool/`          | `src/protocol/config.ts`    | every path under it is spool's                                    |
| `OWN_PREFIX`          | `/.spool/`          | `src/protocol/beacon.ts`    | event paths under it always travel in a batch                     |
| `VIEW_PATH`           | `/.spool/view`      | `src/protocol/view.ts`      | the path of a view event                                          |
| `LOADS_PATH`          | `/.spool/loads`     | `src/protocol/view.ts`      | the path of a loads report                                        |
| `DROPPED_PATH`        | `/.spool/dropped`   | `src/protocol/beacon.ts`    | the path of a drop count                                          |
| `ARTIFACT_TAG_PREFIX` | `spool:artifact:`   | `src/protocol/sync.ts`      | prefix of the tag that drops an artifact by id                    |
| `CLEAR_ALL`           | `*`                 | `src/protocol/envelope.ts`  | the `Spool-Clear` token that wipes everything                     |
| `CLIENT_TAG_ATTR`     | `data-spool-client` | `src/protocol/tag.ts`       | the attribute that marks the page runtime tag                     |
| `GA4_RECOMMENDED_MS`  | 172,800,000         | `src/protocol/collector.ts` | the 48-hour attribution window of the GA4 Measurement Protocol    |
| `GA4_HARD_MS`         | 259,200,000         | `src/protocol/collector.ts` | the 72-hour backdating limit; a `ga4` collector may not exceed it |

Limits that live in the server and the worker and are not exported from the protocol module:

| Constant           | Value      | Defined in             | What it bounds                                                                                        |
| ------------------ | ---------- | ---------------------- | ----------------------------------------------------------------------------------------------------- |
| `MAX_PIGGYBACK`    | 32         | `src/server/spool.ts`  | changed tags a response carries in `Spool-Invalidate` before the worker is left to ask `/.spool/sync` |
| `MAX_BEACON_BODY`  | 262,144    | `src/server/beacon.ts` | characters in one flush request the server reads                                                      |
| `MAX_STATIC_BYTES` | 4,194,304  | `src/sw/static.ts`     | bytes of one static file the worker keeps (4 MiB)                                                     |
| `MAX_HOLD_MS`      | 86,400,000 | `src/sw/analytics.ts`  | age at which held events leave on their own flush, at most once per such window                       |
| `VIEW_BATCH`       | 20         | `src/sw/analytics.ts`  | held views that make a network moment worth a flush                                                   |
| `VIEW_HOLD_MS`     | 3,600,000  | `src/sw/analytics.ts`  | age of the oldest held event that makes a network moment worth a flush                                |
| `FLUSH_CHUNK`      | 100        | `src/sw/analytics.ts`  | events in one flush request                                                                           |

Proxy defaults (`src/proxy/proxy.ts`, `src/proxy/purge.ts`):

| Option or constant | Default   | What it bounds                                                   |
| ------------------ | --------- | ---------------------------------------------------------------- |
| `maxTags`          | 512       | tags one response may name before it is not kept                 |
| `maxBytes`         | 2,097,152 | bytes of a page the proxy keeps (2 MiB)                          |
| `maxRemembered`    | 10,000    | pages whose last body hash is remembered, the oldest going first |
| `MAX_BODY`         | 65,536    | characters in a purge request body                               |
| `MAX_TAGS`         | 1000      | tags in one purge request                                        |
| `MAX_TAG_LENGTH`   | 1024      | characters in one purge tag                                      |

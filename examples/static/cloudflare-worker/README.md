# Static Cloudflare Worker Example

Serves the changelog from a Worker with an assets directory. `publish.ts` writes the static tier to
`public/`, and the assets answer those files before the Worker runs. The site comes from
`../shared/site`.

Run it:

```sh
cd cloudflare-worker
npm install
node publish.ts
npx wrangler dev --local
```

The example does not deploy and uses no account.

## Configuration

```jsonc
{
  "name": "spool-example-static-worker",
  "main": "worker.ts",
  "compatibility_date": "2026-08-01",
  "assets": { "directory": "./public" }
}
```

Two settings are left at their defaults. Both behaviours come from Cloudflare's documentation
(read, and not run against a deployed Worker):

- `run_worker_first` defaults to false. A request that matches a file in `public/` goes to the
  assets with no Worker invocation, and the docs list requests to static assets as free and
  unlimited.
- `not_found_handling` defaults to none. A path with no file, such as every document, invokes the
  Worker, which answers it.

`publish.ts` writes `public/_headers`. The docs say Workers parses that file and applies it to asset
responses. In `wrangler dev --local` the stub came back with `cache-control: max-age=86400` and
`service-worker-allowed: /`, and the runtime and pack with `cache-control: public, max-age=31536000,
immutable`, so the local assets path applies it. A deployed Worker was not run. The pack has no file
extension, so the assets send it with no `content-type`.

`wrangler.count.jsonc` and `count.ts` are for `measure.ts`. `count.ts` is its own Worker, not a wrapper
of `worker.ts`. It counts invocations and sets `x-worker-invoked` on each response it produces to the
running count, so a response without that header came from the assets. It answers `GET /__count` and
`POST /__add` for the rig. `MODE=none` serves the origin page with no spool, and `LEASE` sets the stub
lease in seconds. The count cannot show Cloudflare's own billing, only which side answered in
`wrangler dev`.

## Results

The counts for this Worker come from the `static-host` reading, which ran it under
`wrangler dev --local` with one reader per engine and arm. See [Static Tier Example](../README.md#results).
This example has no reading of its own under `measurements/`.

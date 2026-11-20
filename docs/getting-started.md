# Getting Started

This page walks through a first working site: install the package or the script, declare one
route, wire it into the server, run it, and check that the device answers the page locally. The
[README Quick Start](../README.md#quick-start) gives the same three moves in less space. The
[Adapters](adapters/README.md) index has one page per framework once the first route works.

## Choose How the Runtime Arrives

The page runtime reaches a browser in one of three ways. Pick one before you wire the server.

- **Package.** Install `@drupflare/spool` and import it from your server code. Node, Deno, Bun,
  Workers and bundlers import the package directly. This is the path the examples use.

  ```sh
  bun add @drupflare/spool
  ```

- **CDN script.** Load the runtime from `cdn.drupflare.com` with a Subresource Integrity hash. The
  release notes list the hash for each version, and `createSpool` injects the same tag when it
  decorates a page.

  ```html
  <script
    src="https://cdn.drupflare.com/spool/<version>/client.js"
    integrity="sha384-<hash from the release notes>"
    crossorigin="anonymous"
    defer
    data-spool-client
  ></script>
  ```

- **Direct files.** `spool-sw.js`, `client.js` and `manifest.json` are attached to every GitHub
  release and published under `https://cdn.drupflare.com/spool/<version>/`. A site that serves
  them as plain files needs no server library. [Static Sites](../README.md#static-sites) covers
  that case.

This page follows the package path.

## Declare a Route

A route has a path pattern, a strategy, the tags it depends on and a `load` function that returns
the data for one page. `load` runs on the server and may check the visitor's identity. Only its
result reaches the device.

Save this as `routes.ts`. The template renders `{{id}}`, so the page the application returns has to
match it:

```ts
import { defineRoute } from '@drupflare/spool/server';

export const routes = [
  defineRoute('/node/:id', {
    strategy: 'template',
    template: {
      source:
        '<!doctype html><html><head><title>Node {{id}}</title></head><body><h1>Node {{id}}</h1></body></html>'
    },
    depends: (ctx) => [`node:${ctx.params['id']}`],
    load: (ctx) => ({ id: ctx.params['id'] })
  })
];

const escape = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export const page = (request: Request) => {
  const id = escape(new URL(request.url).pathname.split('/')[2] ?? '');
  return new Response(
    `<!doctype html><html><head><title>Node ${id}</title></head><body><h1>Node ${id}</h1></body></html>`,
    { headers: { 'content-type': 'text/html; charset=utf-8' } }
  );
};
```

`page` stands in for your application. The device renders the route from its template and its
data without asking the server, so the two have to agree. If they drift, the shadow mode described
in [Advanced Usage](../ADVANCED_USAGE.md#shadow-mode) reports the mismatch before a visitor sees it.

## Keep the Version Store

The version store records which tags changed. `memoryStore` serves a single process, and it is the
right choice for a first run. Every other deployment needs a store that all instances share. Any
object with three methods works: `bump(tags)`, `cursor()` and `diff(from)`. On Cloudflare,
`durableObjectStore` keeps the vector in a Durable Object, as the
[Cloudflare Workers](adapters/cloudflare-workers.md) page shows.

```ts
import { memoryStore } from '@drupflare/spool/stores';

export const store = memoryStore();
```

## Create the Spool

`createSpool` joins the routes and the store into one instance. Every adapter calls the same
methods on it: `handle` for a Fetch handler, and `respond`, `decorate` and `stub` for frameworks
that take the pieces one at a time.

```ts
import { createSpool } from '@drupflare/spool/server';
import { routes } from './routes';
import { store } from './store';

export const spool = createSpool({ routes, store });
```

When a write changes data, call `spool.invalidate` with the tags it touched. Devices that hold a
page depending on those tags fetch a fresh copy before they show it again:

```ts
await spool.invalidate(['node:1']);
```

## Run It

The fastest route to a running site is the Node example. Its server is a `node:http` listener, so
it needs no framework. Install the example's dependencies in its folder first, as
[examples/README.md](../examples/README.md) describes, then run it:

```sh
cd examples/courses/node
node server.ts
```

Use the port the server listens on in the checks below, and open `/node/1` in a browser.

Any other runtime follows the same shape. The [Adapters](adapters/README.md) index lists the
import path and the example folder for each one.

## Check That It Works

Three checks show the setup is correct. Run them against the running server.

1. **The worker script is served.** The runtime needs `/spool-sw.js`, which answers with a 200
   status:

   ```sh
   curl -i http://localhost: < port > /spool-sw.js
   ```

2. **The page carries the gate.** The HTML the application returns for `/node/1` contains the
   `data-spool-gate` element. Its absence means `handle` or `decorate` did not run on that
   response:

   ```sh
   curl -s http://localhost: < port > /node/1 | grep -c data-spool-gate
   ```

3. **The envelope is set.** The response carries the `Spool-Artifact` header, which describes the
   stored copy of the page:

   ```sh
   curl -sI http://localhost: < port > /node/1 | grep -i spool-artifact
   ```

If the first check fails, the server does not answer `/spool-sw.js`. If the second or third fails,
the page did not pass through `spool.handle` or `spool.decorate`.

To see a local view, open the page in a browser and wait for the worker to install. Later loads of
the page then render from the device.

## Know What Stays on the Network

A device answers a page locally only when the route is public, the stored copy is fresh under the
route's freshness contract, and the URL has no query string the route does not declare. Everything
else goes to the server as it always did. The defaults and the rules for each are in
[Freshness Contracts](../ADVANCED_USAGE.md#freshness-contracts) and
[Query Routes](../ADVANCED_USAGE.md#query-routes).

Writes go to the server. Queued writes are a separate feature, off by default, that a route
declares. See [Declared Writes](../ADVANCED_USAGE.md#declared-writes).

## What to Read Next

- [Configuration](configuration.md): the settings a first deployment decides, with defaults and
  recommended values.
- [Adapters](adapters/README.md): the page for your framework, with its import path and example.
- [Advanced Usage](../ADVANCED_USAGE.md): the route fields, freshness, datasets, authenticated data,
  declared writes, analytics, proxy mode and the reports.
- [Wire Protocol](protocol.md): the paths, headers and JSON bodies, for anyone who writes an adapter
  or a second server.
- [Security](security.md): the threat model, the controls and the limits of local answers.

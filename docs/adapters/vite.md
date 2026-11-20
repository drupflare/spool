# Vite

`spoolVite` is a Vite plugin. In `vite dev` it adds the page runtime tag to each HTML entry and
serves `/spool-sw.js` and spool's own paths from the `Spool` instance. In `vite build` it writes the
static tier into the output directory, described below. The built HTML is left as Vite wrote it: a
production build is served by the app's spool server, which adds the same tag to each response.

```ts
import { spoolVite } from '@drupflare/spool/vite';
import { defineConfig } from 'vite';
import { spool } from './server/spool';

export default defineConfig({
  plugins: [spoolVite({ spool })]
});
```

`spoolVite` reads no route list, so a dynamic page needs a family that the app declares on its `Spool`,
as the Nuxt section shows.

## Static Tier

A client build ends with `spool.publishStatic` into `build.outDir`, so a static host serves spool's own
files with no Worker invocation. It is not prerendering: the site's HTML still comes from the site's
server. The files are the page runtime, the worker script at `/spool-sw.js`, the packs held for the store
cursor and the deltas between them, the boot script of each pack and a `_headers` file. After a first visit
the device renders held pages from the pack and makes no request. The default moves spool's own endpoints
(the stub, the runtime files and the packs) off the Worker meter.

It is on by default. `static: false` turns it off, and an object sets the parts a build can need:

- `policy` is the site's security headers, which the worker replays on pages it renders locally. Without it
  the plugin uses the `policy` option of the spool, then the headers of a page the instance already
  answered, then the `/*` block of the `_headers` file in the output directory. With none of them the stub
  names no policy, and the build logs one line saying so. A device then makes one network view that teaches
  it the headers, and renders locally from the next view on. Never pass `{}` to skip this: it says the site
  sends no security headers.
- `spool` is a function that makes the instance from the build, `({ outDir }) => spool`. A single-page app
  needs it when the shell routes must hold the built `index.html`, because the instance made when
  `vite.config.ts` loads holds the dev one.
- `url` is the origin the seed functions of the datasets receive, `http://localhost/` by default.

The build loads the instance in Node, so its stores and bundles must be reachable from the build machine.
The pack is named after the store cursor. A `memoryStore` starts at the build process's own state, so the
published pack matches the deployed origin only when both start from the same one. A site on a shared store
publishes after its data is final.

A build that cannot publish fails with the library's error. `static: false` is the way to skip it. An
existing `_headers` file keeps its lines, and spool's two blocks are added at the end and replaced on the next
build. The dev server never publishes.

## Example Project

[`examples/static/vite-vue`](../../examples/static/vite-vue/README.md) builds a Vue app with
`spoolVue`, which takes the same `static` option. `bun run typecheck` compiles the fence above.

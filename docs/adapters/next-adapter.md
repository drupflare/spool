# Next Adapter

`@drupflare/spool/next` reads the App Router pages that `next build` produces. Set `adapterPath` to the
subpath. After the build, the adapter writes one registration per page to `.next/spool-pages.json` and
prints a report. A page with params is a family only when `generateStaticParams` prerendered some of
its params. A dynamic page without prerendered params, a catch-all page and a page under Cache
Components stay on the network, with the reason.

The adapter does not publish the static tier, unlike the Vite, React Router and Nuxt plugins. Next loads an
adapter from a module path with no options, so the adapter has no `Spool` instance to publish from, and
Next's public files are served by the host (Vercel, OpenNext or a Node server), so no single output directory
belongs to it. To serve spool's own files (the page runtime, the worker script, the packs and a `_headers`
file) with no Worker invocation, run `spool.publishStatic(fileStaticSink(dir), { url })` from a script after
the build, into the directory your host serves. The files are not prerendered pages. The
[static example](../../examples/static/README.md) shows the script form.

```ts
// next.config.ts
import type { NextConfig } from 'next';

const config: NextConfig = {
  adapterPath: '@drupflare/spool/next'
};

export default config;
```

The layout adds the page runtime tag, and two route handlers answer the worker script and spool's paths:

```tsx
// app/layout.tsx
import { spoolTag } from '@drupflare/spool/next';
import type { ReactNode } from 'react';
import { spool } from '../server/spool';

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div
          hidden
          dangerouslySetInnerHTML={{ __html: spoolTag(spool) }}
        />
        {children}
      </body>
    </html>
  );
}
```

```ts
// app/spool-sw.js/route.ts and app/.spool/[...path]/route.ts
import { spoolRouteHandler } from '@drupflare/spool/next';
import { spool } from '../../server/spool';

export const dynamic = 'force-dynamic';
export const GET = spoolRouteHandler(spool);
```

App Router pages have no response hook, so the layout cannot set the envelope headers. A page is held
only when its response passes through `spool.handle` in front of Next. Without that wrapper, a page carries the tag and no envelope. `next dev` runs no adapter, so the
report comes from the build only.

## Example Project

`examples/homepage/next/` runs the adapter. Run `npx next build`, then `node server.ts` in that folder.
The dashboard example has a Next.js folder too (`examples/dashboard/next/`). Both examples navigate by
document, so the first click loads the boot script in place of the document and the later clicks run
in the page with no request; the worker registers on the third document view as it does for any
document-navigating site. The home page `/` is a `template` route in the homepage example, so a view
of it is local once the worker holds its artifact.

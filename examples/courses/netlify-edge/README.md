# Netlify Edge Functions example

A course site behind a Netlify Edge Function. The site is defined in `../shared/site.ts`. The edge function runs in front of the site on every path. `context.next()` returns the response the site would send, and `spool.handle` decorates it.

The spool endpoints and the course pages are answered by spool, and every other request reaches the site. The `courses` dataset is built into a pack when the function starts, held in memory and served from `/.spool/bundle/1`.

Run it from a Netlify project by placing the file at `netlify/edge-functions/netlify-edge.ts`, copying `../shared/`
to `netlify/shared/` (the import resolves from `netlify/edge-functions/`), and running `netlify dev`. The site behind it must serve its own pages, because `context.next()` does not call the shared site.

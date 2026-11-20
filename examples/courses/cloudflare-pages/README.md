# Cloudflare Pages Functions example

A course site as a Pages Function. The site is defined in `../shared/site.ts`. The function takes a context with the request and a `next` that runs the next function or the static asset server. `spool.handle` answers spool's paths and passes the rest to `next`.

The `courses` dataset is built into a pack on the first request, held in memory and served from `/.spool/bundle/1`. A deployed Pages project builds one pack per isolate.

To run it, copy the file to `functions/[[path]].ts` and the `shared` folder to `shared/` beside `functions` in a Pages project, because the import `../shared/site.ts` resolves from `functions/`. Then run `npx wrangler pages dev <build directory>`. `next` serves static files, so the course pages need files in the build directory. The shared site does not write them.

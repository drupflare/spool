# Netlify Functions example

A course site as a Netlify Function. The site is defined in `../shared/site.ts`. The function takes a `Request` and returns a `Response`. `spool.handle` answers spool's paths and passes the pages to the site.

The `config.path` list sends the course pages, `/ping`, the worker script and the spool endpoints to the function. The `courses` dataset is built into a pack when the function starts, held in memory and served from `/.spool/bundle/1`. Each function instance builds its own pack.

Run it from a Netlify project by placing the file at `netlify/functions/netlify-functions.ts`, copying `../shared/`
to `netlify/shared/` (the import resolves from `netlify/functions/`), and running `netlify dev`.

`netlify dev` also sets up the Edge Functions environment before it answers. On one run it stayed at that step for over
three minutes and served 404s. To serve the function alone, run `netlify functions:serve --port 8888 --offline -f netlify/functions` from the same project.

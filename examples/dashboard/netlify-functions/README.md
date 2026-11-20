# Team task board, Netlify Functions

The board as a Netlify Function. `netlify-functions.ts` passes every request on the listed paths to
`spool.handle`.

Run it from a Netlify project. Place `netlify-functions.ts` at `netlify/functions/`, copy `../shared/` to
`netlify/shared/` (the import resolves from `netlify/functions/`), then run:

```sh
npm install
netlify dev
```

To serve the function alone, without the Edge Functions setup that `netlify dev` runs first, use
`netlify functions:serve --port 8888 --offline -f netlify/functions` in the same project.

The `config.path` list names the paths the function answers. A new route needs a new entry there.
The path patterns are not run against a deployed Netlify site.

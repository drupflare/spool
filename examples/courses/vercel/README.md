# Vercel example

A course site as a Vercel Function. `vercel.ts` has a default export with `fetch`, the shape Vercel
Functions take. `spool.handle` answers spool's paths and renders the pages. The site is defined in `../shared/site.ts`.

Move `vercel.ts` under `api/` (for example `api/index.ts`), copy `../shared/` to `shared/` at the project root
(the import resolves from `api/`), and keep `vercel.json` at the project root.
The rewrite sends every path to the function. The memory store is per function instance, so this is
a demonstration; a deployed site needs a shared `VersionStore`.

Run it:

```sh
npm install
vercel dev
```

`vercel dev` starts a login flow when the Vercel CLI has no credentials, and it needs a linked project. Without an
account, run the same default export with Bun, which serves any module that exports `fetch`:

```sh
PORT=3000 bun api/index.ts
```

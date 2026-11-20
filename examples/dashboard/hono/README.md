# Team task board, Hono

The board behind `spoolHono`. The middleware answers spool paths, the GET envelope and declared
writes. The application answers every method.

Run it with any runtime that takes a Hono app's `fetch` export, for example:

```sh
npm install
bun app.ts
```

The test suite calls `app.fetch` directly.

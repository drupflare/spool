# Team Task Board, Next.js

The team board in Next.js 16. The site is defined in `../shared/site.ts`. One catch-all route handler under
`app/[[...path]]` serves the site's pages and JSON paths, and `server.ts` fronts Next with `spool.handle`, which
answers the worker script and spool's paths and decorates each held response.

The build uses `@drupflare/spool/next` as the Next adapter (`adapterPath` in `next.config.ts`). The example has no
App Router page files, so the adapter reports no registered pages, and the single optional catch-all `[[...path]]`
does not convert to a spool pattern. `server/spool.ts` therefore lists the two board patterns it serves,
`/board/tasks/:id` and `/board/projects/:id`, and passes them to the site as page records for `routesFromPages`. The
first click on a board link loads the boot script in place of the document and installs the pack, and the later
board clicks of the same run made no request in Chromium (not measured in Firefox or WebKit), except the click back
to `/`: the board `/` is a `template` route over the public `tasks` and `projects` tables (declared through the
`/` page record above), but its artifact is fetched only once the worker controls the page, so that click was a
document load with 2 requests in a run that had made two document views (L1). In the four-view run the worker registered on the third
view and the fourth fetched the artifact of `/`; a fifth view was not run.

Run it from a repository checkout:

```sh
# at the repository root
bun run build

# in this folder
bun install --force --ignore-scripts
npx next build
PORT=5610 node server.ts
```

`server.ts` starts Next on a loopback port after the build, so run `next build` first.

An App Router page is held only when its response passes through `spool.handle` in front of Next, which is what
`server.ts` does. Next's adapter registers App Router pages at build time only.

## Verify

With the server running on port 5610, these commands return the status codes shown:

```sh
curl -s -o /dev/null -w '%{http_code}\n' localhost:5610/                       # 200
curl -s -o /dev/null -w '%{http_code}\n' localhost:5610/board/tasks/t1         # 200
curl -s -o /dev/null -w '%{http_code}\n' localhost:5610/me                     # 401 without a sign-in
curl -s -o /dev/null -w '%{http_code}\n' localhost:5610/spool-sw.js            # 200
curl -s -o /dev/null -w '%{http_code}\n' localhost:5610/.spool/1.0.0/client.js # 200
curl -s -c jar.txt -o /dev/null -X POST 'localhost:5610/login?as=ada'          # 200, sets the user cookie
curl -s -b jar.txt -D - -o /dev/null -X POST localhost:5610/tasks \
  -H 'content-type: application/json' \
  -d '{"project":"site","title":"Write the FAQ","due":"2999-12-05"}' # 201, with a Spool-Delta header
```

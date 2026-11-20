# Team Task Board, Nuxt

The team board in Nuxt 4. The site is defined in `../shared/site.ts`, and the `@drupflare/spool/nuxt` module serves
the worker script and spool's paths from Nitro. The board, task and project pages are Vue pages. The site's JSON
paths (`/tasks`, `/tasks/:id`, `/tasks/:id/complete`, `/projects/:id`) and its sign-in, sign-out and `/me` pages are
Nitro routes that call `spool.handle` with the site's origin page.

Run it from a repository checkout:

```sh
# at the repository root
bun run build

# in this folder
bun install --force --ignore-scripts
npx nuxt build
PORT=5600 node .output/server/index.mjs
```

The Nitro target is `es2022` because `server/spool.ts` uses top-level await to build the site.

`server/spool.ts` passes the `#spool/pages` records to the site. The site declares a family template for the two board
pages Nuxt registers, `/board/tasks/:id` and `/board/projects/:id`, with `routesFromPages`, and keeps `/projects/:id`,
`/me`, `/tasks` and `/tasks/:id` as its own routes because they are not pages. `/` is a `template` route over the
public `tasks` and `projects` tables (the page is a function of those rows and the project names, and the origin renders
the same template). `/login` is registered and undeclared, and the server logs it as `spool: no route declared for
/login`: the sign-in form depends on the visitor's cookie. `GET /tasks` returns `{ tasks, query }`, the body the held
collection answers with, and `pages/index.vue` reads `data.tasks`; the first version of this example returned a bare
array from the origin and the worker's local answer is the object, so the board rendered garbage from the worker (L1,
found by the router-only run below).

Every public page carries the ring that names the boot script. Nuxt's router takes the first board click, so that click
makes the page's own `GET /tasks/<id>`, the boot script and the worker script (`/spool-sw.js`): the gate leaves a
router-taken click to the router and the runtime registers the worker on that view, because a router makes no document
views. Measured with a router-only visit (view 1, then five router clicks and no reload, Chromium, L1): click 1 makes
3 requests to the server, clicks 2 to 5 make 0, and the worker answers `GET /projects/site`, `GET /tasks` and
`GET /tasks/<id>`. Firefox and WebKit made 0 from click 2 as well. The held-click goal holds for this example from the
second click.

## Verify

With the server running on port 5600, these commands return the status codes shown:

```sh
curl -s -o /dev/null -w '%{http_code}\n' localhost:5600/                       # 200
curl -s -o /dev/null -w '%{http_code}\n' localhost:5600/board/tasks/t1         # 200
curl -s -o /dev/null -w '%{http_code}\n' localhost:5600/me                     # 401 without a sign-in
curl -s -o /dev/null -w '%{http_code}\n' localhost:5600/spool-sw.js            # 200
curl -s -o /dev/null -w '%{http_code}\n' localhost:5600/.spool/1.0.0/client.js # 200
curl -s -c jar.txt -o /dev/null -X POST 'localhost:5600/login?as=ada'          # 200, sets the user cookie
curl -s -b jar.txt -o /dev/null -w '%{http_code}\n' -X POST localhost:5600/tasks \
  -H 'content-type: application/json' \
  -d '{"project":"site","title":"Write the FAQ","due":"2999-12-05"}' # 201, with a Spool-Delta header
```

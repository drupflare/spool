# Team task board

A write-heavy board: projects, tasks and members. Members create, edit, move and complete tasks, and
delete them. Every write answers with `Spool-Delta`, the changed rows of the public datasets, so the
device updates the item and counter rows it holds. A collection read after a write comes from the
held pack, with no request.

The site lives in `shared/site.ts` and every runtime imports it. It shows these features:

- Declared resources. `defineResource('/tasks', ...)` expands the collection, the item family and the
  writes that change them. `POST /tasks` and `DELETE /tasks/:id` declare `response` and `delete`.
  `PATCH /tasks/:id` and `POST /tasks/:id/complete` declare patches that set `status`. The declaration
  changes nothing on this board today, because every answer carries its delta inline; the device
  predicts a row only past the 16,384-byte delta limit or for a declared write to another origin.
- `Spool-Delta` on each write. A create returns the new task and the changed project counter row. A
  move between projects returns both counter rows. A counter row is sent only when its values change.
- Counters with no read. `projects` holds open, done and overdue counts that the server recomputes on
  each write.
- Principal-scoped reads. `/me` is a family route over the principal dataset `members`. It renders the
  signed-in member's own row. The `projects` field goes only to that member, and every other viewer
  gets `id` and `name`. The page shows the member's name and does not list tasks.

Writes need a signed-in member and a project the member belongs to. The `tasks` and `projects` datasets
stay public, because a write delta covers public datasets only. So `/tasks` and `/tasks/:id` answer any
client, and task rows are readable without signing in.

The runtimes follow the README sections "Declared Writes", "Authenticated Data", "Datasets" and
"Strategies". Each runtime folder has its own README with the run command.

The Nuxt and Next.js runtimes are in `nuxt/` and `next/`. Each one has a README with a run command and a verification section.

| Runtime           | Folder               | Writes         |
| ----------------- | -------------------- | -------------- |
| Node `node:http`  | `node/`              | `spool.handle` |
| Cloudflare Worker | `cloudflare-worker/` | `spool.handle` |
| Express           | `express/`           | `spoolExpress` |
| Hono              | `hono/`              | `spoolHono`    |
| Netlify Functions | `netlify-functions/` | `spool.handle` |

`spoolExpress` and `spoolHono` answer spool paths, GET envelopes and declared writes, so the Express and
Hono runtimes send every method through the adapter.

Sign in with `POST /login?as=ada`. The identity is a `user` cookie, and only `ada`, `bo` and `cy` are
valid. The test suite runs every runtime against the same fixed fixture.

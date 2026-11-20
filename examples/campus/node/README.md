# Campus Node example

One site with two parts, both defined in `../shared/site.ts`. The public part has a course list, a
query route with a department filter and pages, a people and news directory with nested paths, a
projection, a data route and a static stylesheet, all served by one pack. The signed-in part has
`/account`, `/classmates/:id`, a login that sends the partition, and a logout that clears the
browser's held rows.

Sign in with `POST /login?as=ada`, then request `/account` with `cookie: user=ada`.

Run it:

```sh
npm install
node server.ts
```

The server listens on port 3000.

# Homepage Node example

The Larkspur College homepage served by `node:http` through `toNodeListener`. The site is defined
in `../shared/site.ts`.

The home page is a projection route: its data holds the three latest stories and the next three
events as row references. The device renders it from the held rows once a renderer is bundled
into the worker. This example does not bundle one, so the home page is answered by the origin.

Run it:

```sh
npm install
node server.ts
```

The server listens on port 3000. The site has no update endpoint; `updateEvent` in
`../shared/site.ts` changes an event and republishes the pack from code.

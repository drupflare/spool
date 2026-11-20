# Azure Functions example

A course site on an Azure Functions v4 HTTP trigger. The handler turns the `HttpRequest` into a
Fetch request, and `spool.handle` answers it. `app.http` routes every path with `{*path}`. The site is defined in `../shared/site.ts`.

Place `azure.ts` under `src/functions/` of a v4 Node project, and copy `../shared/` to `src/shared/` (the
import resolves from `src/functions/`). The project also needs three files that this folder does not hold:

- `package.json` with `"main": "src/functions/*.ts"`, so Core Tools finds the functions.
- `host.json` with `"extensions": { "http": { "routePrefix": "" } }`. The default `api` prefix moves every
  spool path under `/api/`, and spool answers those with 404.
- `local.settings.json` with `"FUNCTIONS_WORKER_RUNTIME": "node"`. Without it Core Tools cannot tell the
  language.

Then run it with Azure Functions Core Tools:

```sh
npm install
func start
```

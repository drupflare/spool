# Google Cloud Functions example

A course site on an HTTP function. The Functions Framework gives the function Express-style `req`
and `res`, and `toNodeListener` turns the spool handler into a listener for them. The site is defined in `../shared/site.ts`.

`package.json` sets `main` to `google-cloud.ts`, which Node runs without a build step. Run the function with the Functions Framework:

```sh
npm install
npx functions-framework --target=spool
```

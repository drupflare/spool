# AWS Lambda example

A course site on a Lambda function with a Function URL. `handle` from `@hono/aws-lambda` converts the JSON event
into a Fetch request, and the Hono app runs `spoolHono` before the page routes. The site is defined in `../shared/site.ts`.

The folder has no local runner. Deploy `lambda.handler` on the Node.js runtime with a Function URL.
`tests/node/examples.spec.ts` calls the handler with a Function URL event.

Install the dependencies before you package the function:

```sh
npm install
```

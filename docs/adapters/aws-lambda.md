# AWS Lambda

Lambda gives a function a JSON event and expects a JSON result, so spool needs an adapter. The
`@hono/aws-lambda` package converts Function URL, API Gateway HTTP API and ALB events. Save the Hono app
from the [Hono](hono.md) page as `hono.ts` and wrap it.

```ts
import { handle } from '@hono/aws-lambda';
import app from './hono';

export const handler = handle(app);
```

## Example Project

`examples/courses/aws-lambda/` wraps the Hono app this way. The example is tested through its handler
and has no local run command.

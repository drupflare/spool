# Google Cloud Functions

The Functions Framework gives an HTTP function Express-style `req` and `res`, so the Node listener
fits as it is.

```ts
import { http } from '@google-cloud/functions-framework';
import { toNodeListener } from '@drupflare/spool/node';
import { page } from './routes';
import { spool } from './spool';

http(
  'spool',
  toNodeListener((request) => spool.handle(request, page))
);
```

## Example Project

`examples/courses/google-cloud-functions/` runs this shape. Run
`npx functions-framework --target=spool` in that folder.

# Blog Example

A public blog with posts, authors, tags and dates. `shared/site.ts` holds the data and the routes.
`node/` and `cloudflare-worker/` serve the same site.

## What It Shows

- Family routes: the post page (`/posts/:id`) and the author page (`/authors/:id`) each render one row.
- Query routes: the home list (`/`), the tag list (`/tags?tag=web`) and the search (`/search?q=Caching`)
  answer new pages and filters from the rows the device holds. Search matches title prefixes.
- Path parameters: the archive (`/archive/2024/03`) is a template route.
- Publish deltas: `addPost` publishes a new pack version. A device that holds the previous version
  receives only the change.

## Publish Deltas

```ts
import { blogSite } from './shared/site.ts';

const { addPost } = await blogSite();
const { version } = await addPost({
  title: 'Forms notes',
  author: 'bo',
  tag: 'design',
  date: '2024-12-01',
  body: 'Forms, in short.'
});
```

`addPost` invalidates the `posts` dependency and builds the pack at the next version. Post ids count
down as posts are added, so the default order of a query is the newest post first. Each post has one
tag, and the tag page lists the posts whose `tag` field matches. Post pages link to the list, the tag, the author and the archive month, and not to a previous or next post.

## Runtimes

- [node](node/README.md): `node:http` through `toNodeListener`.
- [cloudflare-worker](cloudflare-worker/README.md): a Worker `fetch` export.

The routes follow the README sections "Strategies", "Dataset Routes", "Query Routes" and "Datasets".

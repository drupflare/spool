# Homepage Shared Site

The Larkspur College site both runtimes serve. `homepageSite()` returns `{ spool, page, updateEvent }`.

The public datasets (`departments`, `programs`, `people`, `news`) are fixed. The `events` dataset
changes: `updateEvent(id, patch)` writes one row, bumps the dataset cursor and publishes a new pack.
A device that holds the previous cursor gets a patch with that one row.

Each page has a header linking to the sections and a footer linking to the about pages. The list pages link to their detail pages, and the detail pages link back to their list.

All data is generated in the module and invented. The college, the people and the events are fiction.

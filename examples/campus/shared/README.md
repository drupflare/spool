# Campus Shared Site

The campus portal both runtimes serve. `campusSite()` returns `{ spool, page }`.

The public datasets (`courses`, `people`, `news`) are built into a pack at version 1 and served from
`/.spool/bundle/1`. The principal dataset `profiles` is not in the pack: each signed-in person gets
their own rows from `/.spool/dataset`, and the rows are the person and the people who share a course
with them.

Sign-in reads a `user` cookie. Only the ids in `ENROLMENTS` are valid, so a cookie cannot name an
unknown person.

Each page has a header linking to the home page, the catalogue, people, news, sign in and sign out.

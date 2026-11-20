# Shared Course Site

The courses site that the examples serve. Each example calls `courseSpool` and hands the spool to its own runtime.

`courses(count = 3)` returns the rows. Ids start at 101. The first three titles are fixed; later rows read `Course <id>`.

`courseSpool(count = 3)` returns `{ spool, page }`. It builds the `courses` pack at version 1 into memory and creates the spool with the list route `/courses`, the item route `/courses/:id` and the origin page. The pack is served from `/.spool/bundle/1`. Each page has a header linking to the home page and the course list; the list links to every course, and each course links to the list and to the courses before and after it.

To change the size, pass a count, for example `courseSpool(200)`. The item page then carries a ring element.

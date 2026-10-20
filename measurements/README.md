# Measurements

Readings behind `docs/impact.md`, one folder per rig and one file per run (`<date>.json`, or
`<date>-<experiment>.json` when a rig ran more than one experiment that day). Every reading here is
L1, measured on hardware described in the file.

| rig            | measures                                                                        | instrument                             | script                            |
| -------------- | ------------------------------------------------------------------------------- | -------------------------------------- | --------------------------------- |
| `repeat-nav`   | bytes and requests of cold, warm and repeat views on 16 public sites            | Chromium DevTools Protocol             | `scripts/measure/repeat-nav.ts`   |
| `on-wire`      | the same navigations, with the requests and bytes a proxy saw reach the origin  | a counting proxy and Chromium DevTools | `scripts/measure/on-wire.ts`      |
| `zero-network` | server hits per service-worker navigation in Chromium, Firefox and WebKit       | the origin's request log               | `scripts/measure/zero-network.ts` |
| `device-cpu`   | browser CPU per navigation, HTTP revalidation vs a service-worker render        | process CPU time (a proxy, not joules) | `scripts/measure/device-cpu.ts`   |
| `rapl`         | package joules on a desktop CPU, by experiment                                  | RAPL energy counters, a sampled GPU    | `scripts/measure/rapl.ts`         |
| `iphone`       | phone joules per view, back to back and paced; service-worker lifetime          | the battery gauge's accumulated energy | `scripts/measure/iphone.ts`       |
| `payload`      | compressed bytes of a page, its shared shell, its unique part and its node data | plain GETs, gzip, brotli, zstd         | `scripts/measure/payload.ts`      |
| `trim`         | CSS and JS used per page, new aggregate bytes, markup classes, bytes by class   | Chromium coverage and DevTools, zstd   | `scripts/measure/trim.ts`         |
| `link-assets`  | icon, manifest, tile and video requests per navigation, by headers and worker   | the origin's request log, worker log   | `scripts/measure/link-assets.ts`  |

The `rapl` experiments are `views` (optimized caching, spool and shipping headers), `compute-server`
(recompute against a cache, per request), `compute-browser` (the same in Chromium), `projection`
(a result computed on the server or in the page), `inference` (a local model, with the GPU board
sampled), `power-state` (request rate against package watts) and `sw-request` (one `fetch` answered by
the browser cache, a worker, a 304 or a 200). The `iphone` experiments are
`burst`, `paced`, `projection` and `sw-lifetime` over Wi-Fi, and `burst-cellular`, `paced-cellular`
and `radio-cellular` (one isolated request against the same script call without it) over cellular.
The `repeat-nav` experiment `document` records where each document landed after redirects, and
`requests` adds a `requestList` to each home repeat view: one record per request (URL without its
query, host, same-origin flag, type, status, bytes, which cache answered, and the response's
`cache-control`, `age`, `vary` and `content-type` with `etag`, `last-modified` and `expires` as
present or not), plus the document's `docRedirects`.

## File Format

Each file is one JSON object:

| field                               | contents                                                    |
| ----------------------------------- | ----------------------------------------------------------- |
| `schema`                            | format version, currently `1`                               |
| `rig`, `date`, `layer`              | which rig, the run date (UTC), the evidence layer           |
| `question`                          | what the run answers                                        |
| `instrument`, `machine`, `software` | what read the numbers and what they were read on            |
| `method`                            | windows, rounds, arm order, pacing and any emulation        |
| `exclusions`                        | rules for rows a reader must drop, with the reason          |
| `rows`                              | one object per window or navigation, as the rig recorded it |

Rows carry raw quantities (joules, seconds, navigations, requests). Per-view figures are derived
from them by `scripts/impact.ts`, never stored here. `src/report/measurement.ts` holds the type and
the reader, and a test reads every file in this folder through it. A file must not carry a device
id, a container id or an address other than loopback.

A script writes its file with `--out` set to this folder by default and refuses to replace a file
that exists unless `--force` is given. Run `bun run prettier` over a new file before committing it.

---
name: spool-measure
description: Run a spool measurement rig (repeat-nav, zero-network, device-cpu, on-wire, rapl, iphone, traces) and regenerate docs/impact.md. Use when someone asks to re-measure, add a reading to measurements/, check a figure in the impact doc, or run anything on paisley-park or the iPhone for spool.
---

# Spool Measurement

Every figure in `docs/impact.md` comes from a file in `measurements/` or from `src/report/inputs.ts`.
A rig writes one JSON file. `bun run impact` turns the files into the document. Nothing else edits
the document by hand.

## Before Any Run

1. Read `~/.claude/references/measurement-discipline.md`. A defect that blocks a run is the first
   result. Do not turn a feature off, lower a default, widen a timeout or raise a limit to make a
   run finish.
2. Run the rig with `--dry-run`. It prints the plan with every default resolved and the file it
   would write, and it touches nothing.
3. Check `measurements/<rig>/` for today's file. A second run on the same day refuses to replace
   the first. Pass `--force` only when Gregory asked for the replacement, and name the file you
   replaced.

Each file holds `schema` 1, `rig`, `date` (UTC), `layer`, `question`, `instrument`, `machine`,
`software`, `method`, `exclusions` and `rows`. Rows hold raw quantities. Per-view figures are
derived by `scripts/impact.ts` and never stored in a reading. Keep that split.

## Rigs

All commands run from the repo root.

| rig            | command                                                                         | writes                                         | where                       |
| -------------- | ------------------------------------------------------------------------------- | ---------------------------------------------- | --------------------------- |
| `repeat-nav`   | `bun scripts/measure/repeat-nav.ts [--site URL ...]`                            | `measurements/repeat-nav/<date>.json`          | this Mac, Chromium          |
| `zero-network` | `bun scripts/measure/zero-network.ts`                                           | `measurements/zero-network/<date>.json`        | this Mac, 3 engines         |
| `device-cpu`   | `bun scripts/measure/device-cpu.ts [--navs N] [--rtt MS]`                       | `measurements/device-cpu/<date>.json`          | this Mac                    |
| `on-wire`      | `bun scripts/measure/on-wire.ts [--site URL ...] [--links N]`                   | `measurements/on-wire/<date>.json`             | this Mac, logging proxy     |
| `rapl`         | `bun scripts/measure/rapl.ts run <experiment>`, then `publish`                  | `measurements/rapl/<date>-<experiment>.json`   | paisley-park, rig container |
| `iphone`       | `UDID=<id> bun scripts/measure/iphone.ts --experiment burst --net URL --sw URL` | `measurements/iphone/<date>-<experiment>.json` | the phone, over a cable     |
| `traces`       | `bun scripts/measure/traces.ts <trace.csv> [--views views.jsonl]`               | the file named by `--out`, else stdout         | this Mac                    |

`on-wire` counts requests and bytes at the wire, between the browser and the origin, so it checks
the browser's own counts. Run it over the sites `repeat-nav` visited and keep the two readings
side by side.

`traces` turns an institution's server-work trace (`start,seconds,route,requests,busy_ms`) into the
`Z_peak_work` inputs. It reads a trace and writes a derived result, so it is not a reading.

## paisley-park

Read `~/.claude/references/remote-machines.md` in full first, then brief Gregory before the run:
the commands, what they create, the resources they use and how long.

- `rapl` reads desktop joules, and RAPL is the meter spool uses for them. `energy_uj` is root-only. Gregory runs the `chmod 444` for a session, and it reverts on
  reboot. Never run `sudo` yourself.
- Never touch `/mnt/hdd`, and on `/mnt/ssd` only `/mnt/ssd/work/gmux`. Work under `~/<rig-name>/`
  or `/tmp/`.
- Run the rig as one remote script that survives an ssh disconnect (`nohup setsid`, a done
  marker). The Wi-Fi drops for 10 to 20 seconds around :23 every hour.
- Run containers with `--user "$(id -u):$(id -g)"`, `--memory` and `--cpus`. Check `df -h /` before
  and during a heavy job. Stop below 25 GB free.
- Record the load average per sample and drop contaminated samples. Do not quiet the box, and do
  not change the governor, sysctl or any other system setting. Record what it was.
- Fetch results by name with `scp`. Never `rsync` a sample directory back.
- Run both `rapl.ts` subcommands in the rig container, as the Reproducing section of
  `docs/impact.md` describes. Copy the published JSON into `measurements/rapl/` and say what you
  left running.

## iPhone

The phone is read through `idevicediagnostics` (`AppleSmartBattery`, `AccumulatedSystemEnergyConsumed`
in microwatt-hours) while Safari is driven by `safaridriver`. Xcode's Power Profiler reads nothing
on a cable.

- **A window with any charging tick is invalid.** The accumulated counter then includes charge
  power. The rig records `charging` per tick and lists the rule under `exclusions`. Drop those
  windows. Do not average them in.
- **Register the worker inside the same `safaridriver` session that measures.** A registration made
  in another session does not carry over. The rig registers `/spool-sw.js` with
  `updateViaCache: 'all'`, reloads, and refuses the arm unless `navigator.serviceWorker.controller`
  is set, so a run never measures a network view as a local one.
- Ticks arrive every 20 seconds. Per-view energy below the window noise (about 10 to 25 J) is not
  resolved by a burst run. Use the paced run for pacing effects.
- Never print or store the device id. `UDID` is an environment variable, and the dry run shows only
  whether it is set.

## Regenerate the Impact Document

```sh
bun run impact
bun run impact:check
```

`impact` reads `measurements/**` and `src/report/inputs.ts`, runs `src/report/*` and writes
`docs/impact.md` from `docs/impact.src.md`. `impact:check` fails on any diff, and CI runs it. Run
both after adding a file, then read the diff of `docs/impact.md` for the figure you expected to
move.

## Rules for a Reading

- Label every figure with its layer: L0 published, L1 measured here, L2 derived, L3 scenario. A
  derived number never loses its label.
- Report the modelled 48 J per view and the metered saving together, each labelled. The 48 J is an
  allocation. A RAPL reading on a desktop is a measurement.
- A negative result closes a mechanism. Record the refuted mechanism with its measurement and keep
  the goal open.
- Tests assert contracts as exact counts, such as server hits per local view. They never assert a
  timing or an energy threshold. Magnitudes belong in the measurement file.
- A cross-origin load breaks a zero-network view. The rigs count those loads per view, and a view
  with any is not strict zero-network.

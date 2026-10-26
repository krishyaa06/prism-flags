# Prism Flags — Usage

## Install

```bash
npm install github:krishyaa06/prism-flags
# or run the CLI directly
npx github:krishyaa06/prism-flags --help
```

## JavaScript API

```js
import { evaluate, percent, Region, ControlPlane } from "prism-flags";

const flag = {
  key: "new-checkout", on: true, variations: [false, true],
  rules: [{ id: "india-v5", clauses: [
    { attribute: "country", op: "in", values: ["IN"] },
    { attribute: "appVersion", op: "semverGte", values: ["5.2.0"] },
  ], variation: 1 }],
  fallthrough: percent(10),          // 10% of everyone else
};

evaluate(flag, { key: "u-1", country: "IN", appVersion: "5.3.0" });
// → { value: true, variation: 1, reason: { kind: "RULE_MATCH", ruleId: "india-v5" } }

// multi-region
const regions = ["us-east-1", "ap-south-1"].map((n) => new Region(n));
const cp = new ControlPlane(regions);
cp.setFlag(flag, { actor: "alice", comment: "launch" });
cp.tick(1);                          // deliver
regions[1].evaluate("new-checkout", { key: "u-1" });
console.log(cp.verifyAudit());       // true
```

| Export | What it does |
|---|---|
| `evaluate(flag, ctx, { flags, segments })` | `{ value, variation, reason, bucket? }` |
| `percent(p)` | Boolean rollout helper (`p`% get variation 1) |
| `bucket(flagKey, salt, key)` | Stable bucket in `[0, 100000)` |
| `segmentMatch(segment, ctx)` | Segment membership |
| `OPS` | Operator table (extendable) |
| `new ControlPlane(regions)` | `setFlag`, `publish`, `tick`, `resync`, `lag`, `verifyAudit`, `audit`, `log` |
| `new Region(name, { latency })` | `apply(change)`, `evaluate(key, ctx)`, `partitioned`, `version` |
| `diff(a, b)` | Field-level diff used by the audit log |

## CLI

```bash
$ npx github:krishyaa06/prism-flags eval examples/flags.json --flag new-checkout --ctx '{"key":"u1","country":"IN","appVersion":"5.4.0"}'
$ npx github:krishyaa06/prism-flags rollout examples/flags.json --flag pricing-experiment
$ npx github:krishyaa06/prism-flags bench examples/flags.json
$ npx github:krishyaa06/prism-flags regions
```

| Command | Description |
|---|---|
| `flags eval <file> --flag k --ctx '{…}'` | Evaluate one context and show the reason |
| `flags rollout <file> --flag k [--users N]` | Variation distribution over synthetic users |
| `flags bench <file> [--n N]` | Per-evaluation latency |
| `flags regions` | Replication, partition and kill-switch timeline |

## Live simulator

Open [https://krishyaa06.github.io/prism-flags/](https://krishyaa06.github.io/prism-flags/) or serve the repo root locally (`npx serve .`). The simulator imports the same modules from `src/`.

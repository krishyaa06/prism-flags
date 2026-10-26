#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { evaluate, Region, ControlPlane } from "../src/index.js";
import { c, table, header, fail, bar, ms } from "../src/lib/cli.js";

const [cmd, ...rest] = process.argv.slice(2);
const flag = (n, d) => { const i = rest.indexOf("--" + n); return i >= 0 ? rest[i + 1] : d; };
const pos = rest.filter((x, i) => !x.startsWith("--") && !(rest[i - 1] || "").startsWith("--"));
const HELP = `${c.bold("flags")} — Prism Flags

  flags eval <flags.json> --flag <key> --ctx '{"key":"u1","country":"IN"}'
  flags rollout <flags.json> --flag <key> [--users 100000]   variation distribution
  flags bench <flags.json> [--n 200000]                       evaluation latency
  flags regions                                               replication + partition demo
`;
const load = () => { const f = pos[0]; if (!f) fail("missing flags.json"); return JSON.parse(readFileSync(f, "utf8")); };
try {
  if (!cmd || cmd === "-h" || cmd === "--help") console.log(HELP);
  else if (cmd === "eval") {
    const env = load(), key = flag("flag") || fail("--flag required"), ctx = JSON.parse(flag("ctx", '{"key":"anonymous"}'));
    const r = evaluate(env.flags[key], ctx, env); console.log(header(key, JSON.stringify(ctx)) + "\n");
    console.log(table([["value", c.accent(JSON.stringify(r.value))], ["variation", r.variation], ["reason", r.reason.kind + (r.reason.ruleId ? ` (rule ${r.reason.ruleId})` : "") + (r.reason.error ? " " + r.reason.error : "")], ["bucket", r.bucket ?? c.dim("n/a")]]));
  } else if (cmd === "rollout") {
    const env = load(), key = flag("flag") || fail("--flag required"), N = +flag("users", 100000), f = env.flags[key], counts = new Map();
    const C = ["IN", "US", "DE", "BR"]; for (let i = 0; i < N; i++) { const r = evaluate(f, { key: "user-" + i, country: C[i % 4], appVersion: i % 3 ? "5.3.0" : "4.9.0" }, env); counts.set(JSON.stringify(r.value), (counts.get(JSON.stringify(r.value)) || 0) + 1); }
    console.log(header(key, `${N.toLocaleString()} synthetic users`) + "\n");
    console.log(table([...counts].sort((a, b) => b[1] - a[1]).map(([v, n]) => [c.accent(v), bar(n / N, 30), (100 * n / N).toFixed(2) + "%", n.toLocaleString()]), { head: ["value", "share", "%", "users"] }));
  } else if (cmd === "bench") {
    const env = load(), N = +flag("n", 200000), keys = Object.keys(env.flags), rows = [];
    for (const k of keys) { for (let i = 0; i < 5000; i++) evaluate(env.flags[k], { key: "w" + i }, env); const t = process.hrtime.bigint(); for (let i = 0; i < N; i++) evaluate(env.flags[k], { key: "u" + i, country: "IN", appVersion: "5.3.0", email: "a@b.c" }, env); const ns = Number(process.hrtime.bigint() - t) / N; rows.push([k, ns < 1000 ? ns.toFixed(0) + "ns" : ms(ns / 1e6), Math.round(1e9 / ns).toLocaleString() + "/s"]); }
    console.log(header("evaluation benchmark", `${N.toLocaleString()} evals per flag · node ${process.version}`) + "\n"); console.log(table(rows, { head: ["flag", "per eval", "throughput"] }));
  } else if (cmd === "regions") {
    const rs = [["us-east-1", 0.03], ["eu-west-1", 0.09], ["ap-south-1", 0.14], ["sa-east-1", 0.18]].map(([n, l]) => new Region(n, { latency: l })), cp = new ControlPlane(rs);
    const f = { key: "new-checkout", on: true, variations: [false, true], fallthrough: { variation: 1 } }, out = (s) => console.log(c.dim(`t+${cp.now.toFixed(2)}s `) + s);
    cp.on((e) => e.type === "delivered" && out(`${c.green("✓")} ${e.region.padEnd(11)} v${e.version} ${c.dim(`lag ${(e.lag * 1000).toFixed(0)}ms`)}`));
    out(c.accent("publish v1 new-checkout ON")); cp.setFlag(f, { actor: "alice" }); for (let i = 0; i < 6; i++) cp.tick(0.05);
    out(c.red("✕ partition ap-south-1")); rs[2].partitioned = true;
    out(c.accent("publish v2 new-checkout OFF (kill switch)")); cp.setFlag({ ...f, on: false }, { actor: "oncall", comment: "INC-2231" }); for (let i = 0; i < 8; i++) cp.tick(0.05);
    console.log(table(rs.map((r) => [r.name, "v" + r.version, cp.lag(r) ? c.yellow(`${cp.lag(r)} behind`) : c.green("in sync"), JSON.stringify(r.evaluate("new-checkout", { key: "u1" }).value)]), { head: ["region", "version", "status", "u1 sees"] }));
    out(c.green("heal ap-south-1")); rs[2].partitioned = false; for (let i = 0; i < 6; i++) cp.tick(0.05);
    out(`all regions v${cp.version}: ${rs.every((r) => r.version === cp.version) ? c.green("converged") : c.red("diverged")} · audit chain ${cp.verifyAudit() ? c.green("valid") : c.red("broken")}`);
  } else fail(`unknown command "${cmd}"\n\n${HELP}`);
} catch (e) { fail(e.message); }

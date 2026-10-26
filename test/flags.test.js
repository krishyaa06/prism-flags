import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { evaluate, bucket, percent, Region, ControlPlane } from "../src/index.js";
const { flags, segments } = JSON.parse(readFileSync(new URL("../examples/flags.json", import.meta.url)));
const env = { flags, segments }, nc = flags["new-checkout"];

test("off, targets, segments, rules and fallthrough", () => {
  assert.equal(evaluate({ ...nc, on: false }, { key: "a" }).reason.kind, "OFF");
  assert.equal(evaluate(nc, { key: "vip-1" }, env).reason.kind, "TARGET_MATCH");
  const b = evaluate(nc, { key: "x", email: "dev@prism.dev" }, env); assert.equal(b.value, true); assert.equal(b.reason.ruleId, "beta");
  assert.equal(evaluate(nc, { key: "u-42" }, env).reason.ruleId, "beta");
  const old = evaluate(nc, { key: "y", country: "IN", appVersion: "5.1.9" }, env); assert.equal(old.reason.kind, "FALLTHROUGH");
  const nw = evaluate(nc, { key: "y", country: "IN", appVersion: "5.10.0" }, env); assert.equal(nw.reason.ruleId, "india-mobile");
  assert.equal(evaluate(nc, {}, env).reason.error, "MISSING_CONTEXT_KEY");
});
test("rollouts are deterministic and match their weights", () => {
  let on = 0; const N = 50000; for (let i = 0; i < N; i++) if (evaluate(nc, { key: "user-" + i }, env).value) on++;
  assert.ok(Math.abs(on / N - 0.1) < 0.01, `~10% got ${on / N}`);
  assert.deepEqual(evaluate(nc, { key: "user-77" }, env), evaluate(nc, { key: "user-77" }, env));
  const f = { key: "p", on: true, variations: [false, true], fallthrough: percent(30) };
  let c = 0; for (let i = 0; i < 20000; i++) c += evaluate(f, { key: "k" + i }).variation; assert.ok(Math.abs(c / 20000 - 0.3) < 0.015);
  assert.ok(bucket("a", "s", "u") >= 0 && bucket("a", "s", "u") < 100000);
});
test("increasing rollout % never flips users who were already in", () => {
  const f = (p) => ({ key: "grow", on: true, variations: [false, true], fallthrough: percent(p) });
  for (let i = 0; i < 3000; i++) if (evaluate(f(20), { key: "u" + i }).value) assert.equal(evaluate(f(60), { key: "u" + i }).value, true);
});
test("prerequisites", () => {
  const pe = flags["pricing-experiment"];
  assert.equal(evaluate(pe, { key: "u-7" }, env).reason.kind, "FALLTHROUGH");
  const r = evaluate(pe, { key: "nobody-1" }, env); if (!evaluate(nc, { key: "nobody-1" }, env).value) assert.equal(r.reason.kind, "PREREQUISITE_FAILED");
});
test("multi-region replication converges, survives partitions and reordering", () => {
  const rs = ["us-east", "eu-west", "ap-south"].map((n, i) => new Region(n, { latency: 0.05 * (i + 1) })), cp = new ControlPlane(rs);
  cp.setFlag(nc); rs[2].partitioned = true;
  cp.setFlag({ ...nc, on: false }, { actor: "alice", comment: "incident" });
  for (let i = 0; i < 20; i++) cp.tick(0.05);
  assert.equal(rs[0].version, 2); assert.equal(rs[2].version, 0); assert.equal(rs[2].evaluate("new-checkout", { key: "a" }).reason.error, "FLAG_NOT_FOUND");
  rs[2].partitioned = false; for (let i = 0; i < 20; i++) cp.tick(0.05);
  for (const r of rs) { assert.equal(r.version, 2); assert.equal(r.evaluate("new-checkout", { key: "a" }).reason.kind, "OFF"); }
  // out-of-order delivery is buffered
  const r = new Region("x"); r.apply(cp.log[1]); assert.equal(r.version, 0); r.apply(cp.log[0]); assert.equal(r.version, 2);
});
test("audit log is a tamper-evident hash chain with diffs", () => {
  const cp = new ControlPlane([]); cp.setFlag(nc); cp.setFlag({ ...nc, on: false }, { actor: "bob" });
  assert.deepEqual(cp.audit[1].diff, [{ path: "on", from: true, to: false }]); assert.ok(cp.verifyAudit());
  cp.audit[0].actor = "mallory"; assert.equal(cp.verifyAudit(), false);
});

// Flag evaluation: targeting rules, segments, prerequisites and deterministic percentage rollouts.
import { murmur3 } from "./lib/hash.js";

const semver = (v) => String(v).replace(/^v/, "").split(/[.-]/).slice(0, 3).map((x) => parseInt(x, 10) || 0);
const cmpSemver = (a, b) => { const x = semver(a), y = semver(b); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i]; return 0; };
const reCache = new Map();
export const OPS = {
  in: (v, vals) => vals.includes(v), notIn: (v, vals) => !vals.includes(v),
  startsWith: (v, vals) => typeof v === "string" && vals.some((x) => v.startsWith(x)), endsWith: (v, vals) => typeof v === "string" && vals.some((x) => v.endsWith(x)),
  contains: (v, vals) => typeof v === "string" && vals.some((x) => v.includes(x)),
  matches: (v, vals) => typeof v === "string" && vals.some((x) => { let r = reCache.get(x); if (!r) reCache.set(x, (r = new RegExp(x))); return r.test(v); }),
  lt: (v, vals) => typeof v === "number" && v < vals[0], gt: (v, vals) => typeof v === "number" && v > vals[0],
  lte: (v, vals) => typeof v === "number" && v <= vals[0], gte: (v, vals) => typeof v === "number" && v >= vals[0],
  semverGte: (v, vals) => v != null && cmpSemver(v, vals[0]) >= 0, semverLt: (v, vals) => v != null && cmpSemver(v, vals[0]) < 0,
  before: (v, vals) => v != null && new Date(v) < new Date(vals[0]), after: (v, vals) => v != null && new Date(v) > new Date(vals[0]),
};
/** Stable bucket in [0, 100000) for a context in a flag. Same user → same bucket in every region. */
export const bucket = (flagKey, salt, key) => murmur3(`${flagKey}.${salt}.${key}`) % 100000;
function pickRollout(flag, rollout, ctx) {
  const by = rollout.bucketBy || "key", b = bucket(flag.key, flag.salt || flag.key, ctx[by] ?? ctx.key); let acc = 0;
  for (const w of rollout.variations) { acc += w.weight; if (b < acc) return { variation: w.variation, bucket: b }; }
  return { variation: rollout.variations.at(-1).variation, bucket: b };
}
function clauseMatch(cl, ctx, segments) {
  let r;
  if (cl.op === "segmentMatch") r = cl.values.some((s) => segmentMatch(segments?.[s], ctx));
  else { const fn = OPS[cl.op]; if (!fn) throw new Error(`Unknown operator "${cl.op}"`); const v = ctx[cl.attribute]; r = Array.isArray(v) ? v.some((x) => fn(x, cl.values)) : fn(v, cl.values); }
  return cl.negate ? !r : r;
}
export function segmentMatch(seg, ctx) {
  if (!seg) return false; if (seg.excluded?.includes(ctx.key)) return false; if (seg.included?.includes(ctx.key)) return true;
  return (seg.rules || []).some((rule) => rule.clauses.every((c) => clauseMatch(c, ctx, null)));
}
const result = (flag, idx, reason, extra = {}) => ({ value: flag.variations[idx], variation: idx, reason, ...extra });

/** Evaluate a flag for a context. Never throws for bad contexts — returns the fallback with an error reason. */
export function evaluate(flag, ctx, { flags = {}, segments = {} } = {}, depth = 0) {
  if (!flag) return { value: null, variation: null, reason: { kind: "ERROR", error: "FLAG_NOT_FOUND" } };
  if (!ctx || ctx.key == null) return result(flag, flag.offVariation ?? 0, { kind: "ERROR", error: "MISSING_CONTEXT_KEY" });
  if (!flag.on) return result(flag, flag.offVariation ?? 0, { kind: "OFF" });
  for (const p of flag.prerequisites || []) {
    if (depth > 10) return result(flag, flag.offVariation ?? 0, { kind: "ERROR", error: "PREREQUISITE_CYCLE" });
    const r = evaluate(flags[p.key], ctx, { flags, segments }, depth + 1);
    if (r.variation !== p.variation) return result(flag, flag.offVariation ?? 0, { kind: "PREREQUISITE_FAILED", prerequisiteKey: p.key });
  }
  for (const t of flag.targets || []) if (t.values.includes(ctx.key)) return result(flag, t.variation, { kind: "TARGET_MATCH" });
  for (let i = 0; i < (flag.rules || []).length; i++) {
    const rule = flag.rules[i];
    if (rule.clauses.every((c) => clauseMatch(c, ctx, segments))) {
      if (rule.rollout) { const p = pickRollout(flag, rule.rollout, ctx); return result(flag, p.variation, { kind: "RULE_MATCH", ruleIndex: i, ruleId: rule.id, inRollout: true }, { bucket: p.bucket }); }
      return result(flag, rule.variation, { kind: "RULE_MATCH", ruleIndex: i, ruleId: rule.id });
    }
  }
  const ft = flag.fallthrough || { variation: 0 };
  if (ft.rollout) { const p = pickRollout(flag, ft.rollout, ctx); return result(flag, p.variation, { kind: "FALLTHROUGH", inRollout: true }, { bucket: p.bucket }); }
  return result(flag, ft.variation, { kind: "FALLTHROUGH" });
}
/** Helper: percentage rollout for a boolean flag (pct of users get variation 1). */
export const percent = (pct) => ({ rollout: { variations: [{ variation: 1, weight: Math.round(pct * 1000) }, { variation: 0, weight: 100000 - Math.round(pct * 1000) }] } });

// Multi-region replication: a control plane publishes versioned changes; each region applies them
// after network latency. Partitions delay delivery; regions converge by version (monotonic, idempotent).
import { evaluate } from "./evaluate.js";
import { sha256 } from "./lib/sha256.js";

export class Region {
  constructor(name, { latency = 0.08 } = {}) { this.name = name; this.latency = latency; this.flags = {}; this.segments = {}; this.version = 0; this.partitioned = false; this.inbox = []; this.evals = 0; }
  apply(ch) { // idempotent + ordered by global version
    if (ch.version <= this.version) return false;
    if (ch.version !== this.version + 1) { this.inbox.push(ch); return false; }
    if (ch.kind === "flag") { if (ch.value === null) delete this.flags[ch.key]; else this.flags[ch.key] = ch.value; } else this.segments[ch.key] = ch.value;
    this.version = ch.version; this.inbox.sort((a, b) => a.version - b.version);
    while (this.inbox.length && this.inbox[0].version <= this.version + 1) { const n = this.inbox.shift(); if (n.version === this.version + 1) this.apply(n); }
    return true;
  }
  evaluate(key, ctx) { this.evals++; return evaluate(this.flags[key], ctx, { flags: this.flags, segments: this.segments }); }
}
export class ControlPlane {
  constructor(regions = []) { this.regions = regions; this.version = 0; this.log = []; this.audit = []; this.inflight = []; this.now = 0; this.flags = {}; this.segments = {}; this.listeners = []; }
  on(fn) { this.listeners.push(fn); }
  emit(e) { for (const l of this.listeners) l(e); }
  publish(kind, key, value, { actor = "system", comment = "" } = {}) {
    const before = (kind === "flag" ? this.flags : this.segments)[key] ?? null;
    const ch = { version: ++this.version, kind, key, value: value === null ? null : structuredClone(value), at: this.now };
    if (kind === "flag") { if (value === null) delete this.flags[key]; else this.flags[key] = ch.value; } else this.segments[key] = ch.value;
    this.log.push(ch);
    const prev = this.audit.at(-1)?.hash || "0".repeat(64);
    const entry = { version: ch.version, at: this.now, actor, comment, kind, key, diff: diff(before, value), prev };
    entry.hash = sha256(prev + JSON.stringify([entry.version, entry.actor, entry.key, entry.diff])); this.audit.push(entry);
    for (const r of this.regions) this.inflight.push({ region: r, ch, eta: this.now + r.latency * (0.8 + Math.random() * 0.4) });
    this.emit({ type: "publish", ch, entry }); return ch;
  }
  setFlag(flag, opts) { return this.publish("flag", flag.key, flag, opts); }
  tick(dt) {
    this.now += dt; const keep = [];
    for (const m of this.inflight) {
      if (m.region.partitioned) { m.eta = Math.max(m.eta, this.now + 0.05); keep.push(m); continue; }
      if (m.eta <= this.now) { m.region.apply(m.ch); this.emit({ type: "delivered", region: m.region.name, version: m.ch.version, lag: this.now - m.ch.at }); } else keep.push(m);
    }
    this.inflight = keep;
  }
  /** Bring a (re)joined region up to date from the change log. */
  resync(region) { for (const ch of this.log) if (ch.version > region.version) region.apply(ch); }
  lag(region) { return this.version - region.version; }
  verifyAudit() { let prev = "0".repeat(64); for (const e of this.audit) { if (e.prev !== prev) return false; const h = sha256(prev + JSON.stringify([e.version, e.actor, e.key, e.diff])); if (h !== e.hash) return false; prev = e.hash; } return true; }
}
/** Shallow JSON diff for audit entries. */
export function diff(a, b) {
  if (a === null) return [{ op: "create" }]; if (b === null) return [{ op: "delete" }];
  const out = []; for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) out.push({ path: k, from: a[k], to: b[k] });
  return out;
}

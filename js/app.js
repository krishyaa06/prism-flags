import { evaluate, percent, Region, ControlPlane } from "../src/index.js";
import { $, h, esc, fmt, toast, Loop, bindLoop, LogView, Kpis, Chart, fit, css, hexA } from "./pro.js";

const REG = [["us-east-1", 0.06, "N. Virginia"], ["eu-west-1", 0.16, "Ireland"], ["ap-south-1", 0.24, "Mumbai"], ["sa-east-1", 0.3, "São Paulo"]];
const regions = REG.map(([n, l]) => new Region(n, { latency: l })), cp = new ControlPlane(regions);
const segments = { "beta-testers": { included: ["user-7", "user-42"], rules: [{ clauses: [{ attribute: "email", op: "endsWith", values: ["@prism.dev"] }] }] } };
const FLAGS = {
  "new-checkout": { key: "new-checkout", on: true, salt: "nc1", variations: [false, true], offVariation: 0, rules: [{ id: "beta", clauses: [{ attribute: "segment", op: "segmentMatch", values: ["beta-testers"] }], variation: 1 }], fallthrough: percent(25) },
  "pricing-experiment": { key: "pricing-experiment", on: true, salt: "px", variations: ["control", "annual", "usage"], fallthrough: { rollout: { variations: [{ variation: 0, weight: 50000 }, { variation: 1, weight: 25000 }, { variation: 2, weight: 25000 }] } } },
  "dark-mode": { key: "dark-mode", on: true, variations: [false, true], rules: [{ id: "new-app", clauses: [{ attribute: "appVersion", op: "semverGte", values: ["5.0.0"] }], rollout: percent(60).rollout }], fallthrough: { variation: 0 } },
};
cp.publish("segment", "beta-testers", segments["beta-testers"], { actor: "system", comment: "seed" });
for (const f of Object.values(FLAGS)) cp.setFlag(f, { actor: "system", comment: "seed" });
for (const r of regions) cp.resync(r);
for (const k of Object.keys(FLAGS)) $("#flag").append(h("option", { value: k }, k));
for (const r of regions) $("#reg").append(h("option", { value: r.name }, r.name));
const sel = () => $("#flag").value, cur = () => cp.flags[sel()];

const users = Array.from({ length: 96 }, (_, i) => ({ key: "user-" + (i * 37 + 11), country: ["IN", "US", "DE", "BR"][i % 4], appVersion: i % 5 ? "5.3.0" : "4.8.1", email: i % 23 === 0 ? `dev${i}@prism.dev` : `u${i}@mail.com` }));
const PAL = ["#3b4263", "#22e3a1", "#00d2ff", "#ffb547"];
const packets = []; const flash = new Map();
cp.on((e) => { if (e.type === "delivered") flash.set(e.region, 1); });
const audit = new LogView($("#audit"), 80);
const pushAudit = (e) => audit.html(`<span class="acc">v${e.version}</span> <b>${esc(e.key)}</b> <span class="dim">by ${esc(e.actor)}</span> ${e.diff.map((d) => d.op ? `<span class="ok">${d.op}</span>` : `<span class="warn">${esc(d.path)}</span>`).join(" ")}${e.comment ? ` <span class="dim">“${esc(e.comment)}”</span>` : ""}<br><span class="dim">#${e.hash.slice(0, 16)}… ← ${e.prev.slice(0, 8)}</span>`, `t+${e.at.toFixed(1)}s`);
cp.audit.forEach(pushAudit);
cp.on((e) => { if (e.type === "publish") { pushAudit(e.entry); for (const r of regions) packets.push({ r, v: e.ch.version, t0: cp.now }); $("#chain").textContent = cp.verifyAudit() ? "valid" : "broken"; } });

function publish(next, comment) { cp.setFlag(next, { actor: "you", comment }); showJson(); }
let pend = null;
$("#pct").oninput = (e) => { $("#po").textContent = e.target.value + "%"; clearTimeout(pend); pend = setTimeout(() => { const f = structuredClone(cur()); if (f.variations.length !== 2) return toast("Rollout slider controls boolean flags"); if (f.rules?.[0]?.rollout) f.rules[0].rollout = percent(+e.target.value).rollout; else f.fallthrough = percent(+e.target.value); publish(f, `rollout → ${e.target.value}%`); }, 250); };
$("#toggle").onclick = () => { const f = structuredClone(cur()); f.on = !f.on; publish(f, f.on ? "re-enabled" : "kill switch"); syncBtns(); toast(f.on ? `${f.key} back ON` : `${f.key} killed in every region`); };
$("#part").onclick = () => { const r = regions.find((x) => x.name === $("#reg").value); r.partitioned = !r.partitioned; if (!r.partitioned) toast(`${r.name} healed — buffered changes apply in order`); else toast(`${r.name} partitioned — it keeps serving its last known config`); syncBtns(); };
$("#reg").onchange = syncBtns;
$("#flag").onchange = () => { const f = cur(); const ro = f.rules?.[0]?.rollout || f.fallthrough.rollout; if (ro && f.variations.length === 2) { const p = Math.round((ro.variations.find((v) => v.variation === 1)?.weight || 0) / 1000); $("#pct").value = p; $("#po").textContent = p + "%"; } syncBtns(); showJson(); runEval(); };
function syncBtns() { const f = cur(), r = regions.find((x) => x.name === $("#reg").value); $("#toggle").textContent = f.on ? "Kill switch" : "Turn back on"; $("#toggle").classList.toggle("on", !f.on); $("#part").textContent = r.partitioned ? "Heal" : "Partition"; }
function showJson() { $("#json").textContent = JSON.stringify(cur(), null, 2); }
function runEval() {
  const ctx = { key: $("#ck").value, country: $("#cc").value, appVersion: $("#cv").value, email: $("#ce").value };
  $("#evout").innerHTML = regions.map((r) => { const x = evaluate(r.flags[sel()], ctx, { flags: r.flags, segments: r.segments }); return `<div><span class="t">${r.name.padEnd(10)}</span> <span class="acc">${esc(JSON.stringify(x.value))}</span> <span class="dim">${x.reason.kind}${x.reason.ruleId ? " · " + x.reason.ruleId : ""}${x.bucket != null ? " · #" + x.bucket : ""} · v${r.version}</span>${r.partitioned ? ' <span class="bad">partitioned</span>' : ""}</div>`; }).join("");
}
for (const id of ["#ck", "#cc", "#cv", "#ce"]) $(id).addEventListener("input", runEval);

const kp = new Kpis($("#kpis"), [
  { key: "ver", label: "Version", tone: "acc", fmt: (v) => "v" + Math.round(v) }, { key: "sync", label: "In sync" }, { key: "lag", label: "Max lag", fmt: (v) => Math.round(v) + " ver" },
  { key: "eps", label: "Evals / s" }, { key: "p50", label: "Eval time", fmt: (v) => (v < 1 ? (v * 1000).toFixed(0) + "ns" : v.toFixed(2) + "µs") }, { key: "on", label: "Users ON", fmt: fmt.pct },
]);
const ch1 = new Chart($("#ch1"), { series: regions.map((r, i) => ({ label: r.name, color: ["#00d2ff", "#7c5cff", "#ffb547", "#22e3a1"][i] })), min: 0, max: 4, area: false, points: 100, fmtY: (v) => v.toFixed(1) });
const ch2 = new Chart($("#ch2"), { series: [{ label: "evals/s", color: "--accent" }], min: 0, points: 100 });

function drawMap() {
  const { ctx, w, h: H } = fit($("#map")); ctx.clearRect(0, 0, w, H);
  const narrow = w < 600, cpx = narrow ? w / 2 : 90, cpy = narrow ? 70 : H / 2;
  const cols = narrow ? 2 : 4, cw = narrow ? (w - 30) / 2 : (w - 200) / 4, rh = narrow ? (H - 140) / 2 : H - 70;
  const boxes = regions.map((r, i) => ({ r, x: narrow ? 10 + (i % 2) * (cw + 10) : 190 + i * cw, y: narrow ? 130 + Math.floor(i / 2) * (rh + 10) : 40, w: cw - 10, h: rh - 10 }));
  // links + packets
  for (const b of boxes) { const tx = b.x + b.w / 2, ty = b.y; ctx.strokeStyle = b.r.partitioned ? "#ff5c8a66" : "#ffffff1c"; ctx.setLineDash(b.r.partitioned ? [5, 5] : []); ctx.lineWidth = 1.2; ctx.beginPath(); ctx.moveTo(cpx, cpy); ctx.quadraticCurveTo((cpx + tx) / 2, Math.min(cpy, ty) - 30, tx, ty); ctx.stroke(); ctx.setLineDash([]); }
  for (let i = packets.length - 1; i >= 0; i--) { const p = packets[i], b = boxes.find((x) => x.r === p.r); if (p.r.version >= p.v) { packets.splice(i, 1); continue; } const k = Math.min(0.92, (cp.now - p.t0) / p.r.latency), tx = b.x + b.w / 2, ty = b.y, mx = (cpx + tx) / 2, my = Math.min(cpy, ty) - 30, u = 1 - k; const x = u * u * cpx + 2 * u * k * mx + k * k * tx, y = u * u * cpy + 2 * u * k * my + k * k * ty; ctx.fillStyle = p.r.partitioned ? "#ff5c8a" : css("--accent"); ctx.shadowColor = ctx.fillStyle; ctx.shadowBlur = 10; ctx.beginPath(); ctx.arc(x, y, 4, 0, 7); ctx.fill(); ctx.shadowBlur = 0; ctx.fillStyle = "#c9d1f0"; ctx.font = "10px JetBrains Mono, monospace"; ctx.fillText("v" + p.v, x + 6, y - 6); }
  // control plane
  ctx.fillStyle = hexA(css("--accent"), 0.14); ctx.strokeStyle = css("--accent"); ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(cpx, cpy, 34, 0, 7); ctx.fill(); ctx.stroke();
  ctx.fillStyle = "#e8ecfa"; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.font = "600 11px JetBrains Mono, monospace"; ctx.fillText("control", cpx, cpy - 6); ctx.fillText("plane", cpx, cpy + 7); ctx.fillStyle = css("--accent"); ctx.fillText("v" + cp.version, cpx, cpy + 50);
  // regions
  const f = sel();
  for (const b of boxes) {
    const r = b.r, fl = flash.get(r.name) || 0, lag = cp.lag(r);
    ctx.fillStyle = r.partitioned ? "#250e18" : "#0d1430"; ctx.strokeStyle = r.partitioned ? "#ff5c8a" : fl > 0 ? hexA("#22e3a1", 0.4 + fl * 0.6) : "#2a3560"; ctx.lineWidth = fl > 0 ? 2 : 1; ctx.beginPath(); ctx.roundRect(b.x, b.y, b.w, b.h, 12); ctx.fill(); ctx.stroke();
    ctx.textAlign = "left"; ctx.fillStyle = "#e8ecfa"; ctx.font = "600 12px JetBrains Mono, monospace"; ctx.fillText(r.name, b.x + 12, b.y + 18);
    ctx.font = "10px JetBrains Mono, monospace"; ctx.fillStyle = r.partitioned ? "#ff8fab" : lag ? "#ffb547" : "#22e3a1"; ctx.fillText(r.partitioned ? `partitioned · ${lag} behind` : lag ? `v${r.version} · syncing` : `v${r.version} · in sync`, b.x + 12, b.y + 34);
    ctx.fillStyle = "#5f6884"; ctx.fillText(`${REG.find((x) => x[0] === r.name)[2]} · ${Math.round(r.latency * 1000)}ms`, b.x + 12, b.y + 48);
    const per = narrow ? 8 : Math.max(6, Math.floor((b.w - 24) / 16)), s = Math.min(14, (b.w - 24) / per - 3), gy = b.y + 64;
    users.forEach((u, i) => { const x = r.evaluate(f, u), cx = b.x + 12 + (i % per) * (s + 3), cy = gy + Math.floor(i / per) * (s + 3); if (cy + s > b.y + b.h - 6) return; ctx.fillStyle = PAL[(x.variation ?? 0) % PAL.length]; if (x.variation === 0 || x.variation == null) ctx.fillStyle = "#2b3150"; ctx.beginPath(); ctx.roundRect(cx, cy, s, s, 3); ctx.fill(); });
    flash.set(r.name, Math.max(0, fl - 0.03));
  }
  // legend
  const fv = cp.flags[f].variations; ctx.textAlign = "left"; ctx.font = "10px JetBrains Mono, monospace"; let lx = narrow ? 12 : 190; const ly = H - 14;
  fv.forEach((v, i) => { ctx.fillStyle = i === 0 ? "#2b3150" : PAL[i % PAL.length]; ctx.fillRect(lx, ly - 5, 10, 10); ctx.fillStyle = "#8d94ad"; const t = JSON.stringify(v); ctx.fillText(t, lx + 14, ly + 1); lx += ctx.measureText(t).width + 30; });
}
let acc = 0, evalCount = 0, p50 = 0;
function bench() { const f = cp.flags[sel()], env = { flags: cp.flags, segments: cp.segments }; const N = 3000, t = performance.now(); for (let i = 0; i < N; i++) evaluate(f, users[i % users.length], env); p50 = ((performance.now() - t) / N) * 1000; }
function render() {
  const sync = regions.filter((r) => !cp.lag(r)).length, us = regions[0], on = users.filter((u) => us.evaluate(sel(), u).variation === 1).length / users.length;
  kp.set({ ver: cp.version, sync: `${sync} / ${regions.length}`, lag: Math.max(...regions.map((r) => cp.lag(r))), p50, on });
  kp.tone("sync", sync === regions.length ? "ok" : "warn"); drawMap();
}
const loop = new Loop((dt) => {
  cp.tick(dt); acc += dt;
  // synthetic edge traffic
  const n = Math.round((2200 + 600 * Math.sin(cp.now / 3)) * dt); for (let i = 0; i < n; i++) regions[i % 4].evaluate(sel(), users[(i * 7) % users.length]); evalCount += n;
  if (acc >= 0.25) { ch1.push(...regions.map((r) => cp.lag(r))); ch2.push(evalCount / acc); kp.set({ eps: evalCount / acc }); evalCount = 0; acc = 0; bench(); }
  render();
});
bindLoop(loop, $("#sim"));
showJson(); runEval(); syncBtns(); bench(); render(); loop.start();
// scripted intro: partition Mumbai, ramp rollout, then heal
setTimeout(() => { $("#reg").value = "ap-south-1"; $("#part").click(); }, 1200);
setTimeout(() => { $("#pct").value = 60; $("#pct").dispatchEvent(new Event("input")); }, 2000);
setTimeout(() => { if (regions[2].partitioned) $("#part").click(); setInterval(runEval, 1000); }, 9000);
addEventListener("resize", render);

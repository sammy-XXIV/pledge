// Shared data + helpers for index.html (landing) and app.html (app). Plain script, works from file://.
(function () {
  const q = new URLSearchParams(location.search);
  const CFG = { ADDRESS: q.get("addr") || "", RPC: q.get("rpc") || "https://testnet-rpc.monad.xyz" };
  const STATES = ["None", "Open", "Active", "Committed", "Paid", "Slashed", "Cancelled"];
  const JUDGE_WINDOW = 60;
  const ABI = [
    "function jobCount() view returns (uint256)",
    "function jobs(uint256) view returns (address buyer,address judge,uint256 agentId,address agent,uint256 payment,uint256 bond,uint64 deadline,bytes32 resultHash,uint8 state)",
    "function completed(uint256) view returns (uint256)",
    "function slashed(uint256) view returns (uint256)"
  ];
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const reduce = matchMedia("(prefers-reduced-motion:reduce)").matches;
  const short = (a) => (a && a.length > 12 ? a.slice(0, 6) + "…" + a.slice(-4) : a || "—");
  const link = (href) => href + (location.search && !href.includes("?") ? location.search : "");
  const span = {}; // jobId -> first-seen window for the countdown ring. ponytail: real creation time needs the Created event.

  // Deterministic identicon: blue tile, black mirrored 5x5 pattern from the id.
  function avatar(id, cls = "") {
    let t = (id + 1) * 0x9E3779B9;
    const rnd = () => { t = (t + 0x6D2B79F5) | 0; let x = Math.imul(t ^ (t >>> 15), 1 | t); x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x; return ((x ^ (x >>> 14)) >>> 0) / 4294967296; };
    let cells = "";
    for (let y = 0; y < 5; y++) for (let x = 0; x < 3; x++) if (rnd() > 0.45) {
      cells += `<rect x="${x * 6 + 5}" y="${y * 6 + 5}" width="6" height="6" rx="1.5"/>`;
      if (x < 2) cells += `<rect x="${(4 - x) * 6 + 5}" y="${y * 6 + 5}" width="6" height="6" rx="1.5"/>`;
    }
    return `<svg class="av ${cls}" viewBox="0 0 40 40" aria-hidden="true"><rect width="40" height="40" rx="10" fill="#2B59FF"/><g fill="#000">${cells}</g></svg>`;
  }

  const ICON = {
    Open: '<path d="M12 5v14M5 12h14"/>',
    Active: '<circle cx="12" cy="12" r="8"/><path d="M12 8v4l3 2"/>',
    Committed: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
    Paid: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
    Slashed: '<path d="M13 3L5 14h6l-1 7 8-11h-6z"/>',
    Cancelled: '<path d="M6 12h12"/>',
    shield: '<path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6z"/><path d="M9 12l2 2 4-4"/>',
    clock: '<circle cx="12" cy="12" r="8"/><path d="M12 8v4l3 2"/>',
    wallet: '<rect x="3" y="6" width="18" height="13" rx="3"/><path d="M16 13h2"/>',
    gavel: '<path d="M14 5l5 5M4 20l7-7M10 6l5 5M8 8l6-6 5 5-6 6z"/>',
    layers: '<path d="M12 4l9 5-9 5-9-5z"/><path d="M3 14l9 5 9-5"/>',
    arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
    grid: '<rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/>',
    list: '<path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01"/>',
    users: '<circle cx="9" cy="8" r="3.5"/><path d="M3 20c0-3.5 3-6 6-6s6 2.5 6 6"/><circle cx="17" cy="9" r="2.5"/><path d="M17 14c2.5 0 4 2 4 5"/>',
    x: '<path d="M6 6l12 12M18 6L6 18"/>',
  };
  const svg = (name, cls = "") => `<svg class="ic ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[name] || ""}</svg>`;
  const stateIcon = (s) => `<span class="ji s-${s}">${svg(s)}</span>`;

  function hex(n) { let h = (n + 7) * 2654435761 >>> 0, s = ""; for (let i = 0; i < 5; i++) { h = (Math.imul(h, 1664525) + 1013904223) >>> 0; s += h.toString(16).padStart(8, "0"); } return "0x" + s; }
  function sample() {
    const n = Math.floor(Date.now() / 1000);
    const rows = [
      [0, 1, "1.0", "0.5", n + 90, "Active"], [1, 2, "1.0", "0.5", n - 30, "Active"], [2, 1, "2.0", "1.0", n - 300, "Paid"],
      [3, 2, "1.0", "0.5", n - 600, "Slashed"], [4, 3, "0.8", "0.4", n + 400, "Committed"], [5, 3, "0.5", "0.25", n - 900, "Paid"],
    ];
    return {
      source: "sample",
      jobs: rows.map(([id, agentId, payment, bond, deadline, state]) => ({
        id, agentId, payment, bond, deadline, state, buyer: hex(id), judge: hex(99), agent: hex(agentId + 40),
        resultHash: ["Committed", "Paid"].includes(state) ? hex(id + 200) + "0000".slice(0, 0) : "",
      })),
      agents: [{ id: 1, completed: 1, slashed: 0 }, { id: 2, completed: 0, slashed: 1 }, { id: 3, completed: 1, slashed: 0 }],
    };
  }

  async function load() {
    if (!CFG.ADDRESS) return sample();
    const c = new ethers.Contract(CFG.ADDRESS, ABI, new ethers.JsonRpcProvider(CFG.RPC));
    const count = Number(await c.jobCount());
    const raw = await Promise.all([...Array(count).keys()].map((i) => c.jobs(i)));
    const jobs = raw.map((j, i) => ({
      id: i, agentId: Number(j.agentId), payment: ethers.formatEther(j.payment), bond: ethers.formatEther(j.bond),
      deadline: Number(j.deadline), state: STATES[Number(j.state)], buyer: j.buyer, judge: j.judge, agent: j.agent,
      resultHash: /^0x0+$/.test(j.resultHash) ? "" : j.resultHash,
    }));
    const ids = [...new Set(jobs.map((j) => j.agentId))];
    const agents = await Promise.all(ids.map(async (id) => ({ id, completed: Number(await c.completed(id)), slashed: Number(await c.slashed(id)) })));
    return { source: "live", jobs, agents };
  }

  function countdown(j, now) {
    const left = j.deadline - now;
    if (j.state === "Active") {
      return left > 0
        ? { t: `${left}s left`, f: "", late: false, frac: Math.max(0, Math.min(1, left / (span[j.id] || left || 1))) }
        : { t: `${-left}s late`, f: '<span class="flag">LATE · SLASHABLE</span>', late: true, frac: 0 };
    }
    if (j.state === "Committed" && now > j.deadline + JUDGE_WINDOW)
      return { t: "Judge window over", f: '<span class="flag ok">AGENT CAN CLAIM</span>', late: false, frac: 0 };
    if (j.state === "Committed") return { t: "Awaiting judge", f: "", late: false, frac: 0 };
    return { t: "Deadline " + new Date(j.deadline * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }), f: "", late: false, frac: 0 };
  }
  const R = 15, CIRC = 2 * Math.PI * R;
  const ring = (frac, late) => `<svg class="ring${late ? " late" : ""}" viewBox="0 0 36 36" aria-hidden="true"><circle cx="18" cy="18" r="${R}" class="rt"/><circle cx="18" cy="18" r="${R}" class="rf" stroke-dasharray="${CIRC}" stroke-dashoffset="${CIRC * (1 - frac)}"/></svg>`;
  const seedSpans = (jobs) => { const n = Math.floor(Date.now() / 1000); jobs.forEach((j) => { if (!span[j.id]) span[j.id] = Math.max(j.deadline - n, 1); }); };

  function countUp(el) {
    const to = Number(el.dataset.count), pad = Number(el.dataset.pad || 0), dec = Number(el.dataset.dec || 0);
    const fmt = (v) => (dec ? v.toFixed(dec) : String(Math.round(v))).padStart(pad, "0");
    if (reduce || to === 0) { el.textContent = fmt(to); return; }
    const t0 = performance.now();
    const step = (t) => { const p = Math.min(1, (t - t0) / 1000); el.textContent = fmt(to * (1 - Math.pow(1 - p, 3))); if (p < 1) requestAnimationFrame(step); };
    requestAnimationFrame(step);
  }
  function reveal(root = document) {
    const io = new IntersectionObserver((es) => es.forEach((e) => {
      if (!e.isIntersecting) return;
      e.target.classList.add("in");
      e.target.querySelectorAll("[data-count]").forEach(countUp);
      if (e.target.dataset.count) countUp(e.target);
      io.unobserve(e.target);
    }), { threshold: 0.15 });
    root.querySelectorAll(".rv:not(.in)").forEach((el) => io.observe(el));
  }
  document.head.insertAdjacentHTML("beforeend", `<link rel="icon" href="data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#000"/><path d="M11 14v-3a5 5 0 0 1 10 0v3" stroke="#2B59FF" stroke-width="2.5" fill="none" stroke-linecap="round"/><rect x="8" y="14" width="16" height="11" rx="3" fill="#2B59FF"/></svg>')}">`);

  window.P = { CFG, STATES, JUDGE_WINDOW, $, esc, reduce, short, link, avatar, svg, stateIcon, load, countdown, ring, seedSpans, countUp, reveal };
})();

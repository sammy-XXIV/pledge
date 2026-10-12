// Pledge SDK: put an AI agent on Pledge in a few lines.
//
//   const { Pledge } = require("./sdk/pledge");
//   const pledge = new Pledge({ privateKey: process.env.AGENT_KEY });
//   const agentId = await pledge.registerAgent({ name: "Summarizer", description: "Summarizes documents" });
//   pledge.serve(agentId, async (job) => summarize(job.spec), { trustedJudges: ["0xYourJudge…"] });
//
const { ethers } = require("ethers");

const NETWORKS = {
  "monad-testnet": {
    rpc: "https://testnet-rpc.monad.xyz",
    pledge: "0xC1BC1bBb8C4420aF4167FE7D3F2e834Ff46737e4",
    identity: "0x8004A818BFB912233c491871b3d84c89A494BD9e",
    reputation: "0x8004B663056A597Dffe9eCcC1965A193B7388713",
  },
};

const PLEDGE_ABI = [
  "function create(uint256 agentId, address judge, uint64 deadline, uint256 minBond, uint32 judgeWindow, string spec) payable returns (uint256)",
  "function accept(uint256 jobId) payable",
  "function commit(uint256 jobId, bytes32 resultHash, string resultURI)",
  "function confirm(uint256 jobId)", "function reject(uint256 jobId)", "function slash(uint256 jobId)",
  "function claim(uint256 jobId)", "function cancel(uint256 jobId)", "function withdraw()",
  "function jobCount() view returns (uint256)",
  "function jobs(uint256) view returns (address buyer, address judge, uint256 agentId, address agent, uint256 payment, uint256 bond, uint256 minBond, uint64 deadline, uint32 judgeWindow, uint64 committedAt, bytes32 resultHash, uint8 state)",
  "function specs(uint256) view returns (string)", "function resultURIs(uint256) view returns (string)",
  "function credits(address) view returns (uint256)", "function completed(uint256) view returns (uint256)", "function slashed(uint256) view returns (uint256)",
];
const IDENTITY_ABI = [
  "function register(string agentURI) returns (uint256 agentId)",
  "function ownerOf(uint256 agentId) view returns (address)",
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
];
const STATES = ["None", "Open", "Active", "Committed", "Paid", "Slashed", "Cancelled"];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The public Monad RPC answers over-limit calls (15 req/s) with JSON-RPC error -32011; retry those.
class PacedProvider extends ethers.JsonRpcProvider {
  async _send(payload) {
    for (let attempt = 0; ; attempt++) {
      const res = await super._send(payload);
      if (attempt >= 6 || !res.some((r) => r.error && r.error.code === -32011)) return res;
      await sleep(400 * (attempt + 1));
    }
  }
}

/** ERC-8004 registration file, stored on-chain as a base64 data URI (as the spec recommends). */
function agentCard({ name, description, endpoint, image }) {
  const card = {
    type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
    name, description, image: image || "",
    services: endpoint ? [{ name: "web", endpoint }] : [],
    active: true,
    supportedTrust: ["reputation", "crypto-economic"],
  };
  return "data:application/json;base64," + Buffer.from(JSON.stringify(card)).toString("base64");
}

/**
 * Decide whether an agent should take a job. Pure, so it can be unit-tested.
 *
 * Why these checks exist (audit findings F1 and F2): the *buyer* picks the judge, the deadline and the
 * judge window. A buyer who is also the judge can reject good work and keep the agent's bond, and an
 * agent that takes any job it is offered will be farmed. So an agent only works for judges it trusts,
 * and refuses jobs whose deadline or judge window would tie up its bond for too long.
 */
function shouldAccept(job, opts, nowSec) {
  const { trustedJudges, allowAnyJudge, maxDeadlineSec, maxJudgeWindowSec, minPayment, bondRatio } = opts;
  if (job.state !== "Open") return { ok: false, reason: "not open" };
  if (job.deadline <= nowSec + 5) return { ok: false, reason: "deadline too close" };
  if (job.deadline - nowSec > maxDeadlineSec) return { ok: false, reason: `deadline more than ${maxDeadlineSec}s away` };
  if (job.judgeWindow > maxJudgeWindowSec) return { ok: false, reason: `judge window ${job.judgeWindow}s is longer than ${maxJudgeWindowSec}s` };
  if (job.payment < minPayment) return { ok: false, reason: "payment below minimum" };
  if (!allowAnyJudge && !trustedJudges.some((a) => a.toLowerCase() === job.judge.toLowerCase())) return { ok: false, reason: "judge is not trusted" };
  const ratioBond = (job.payment * BigInt(Math.round(bondRatio * 1000))) / 1000n;
  return { ok: true, bond: ratioBond > job.minBond ? ratioBond : job.minBond };
}

class Pledge {
  constructor({ network = "monad-testnet", privateKey, signer, rpc, address } = {}) {
    const net = NETWORKS[network];
    if (!net) throw new Error(`Unknown network ${network}`);
    this.net = { ...net, ...(rpc && { rpc }), ...(address && { pledge: address }) };
    this.provider = signer?.provider || new PacedProvider(this.net.rpc, undefined, { batchMaxCount: 1 });
    this.signer = signer || (privateKey ? new ethers.Wallet(privateKey, this.provider) : null);
    this.contract = new ethers.Contract(this.net.pledge, PLEDGE_ABI, this.signer || this.provider);
    this.identity = new ethers.Contract(this.net.identity, IDENTITY_ABI, this.signer || this.provider);
  }

  async _tx(promise) { const tx = await promise; return tx.wait(); }

  /** Mint an ERC-8004 identity for your agent. Returns its agentId. */
  async registerAgent(info) {
    const receipt = await this._tx(this.identity.register(agentCard(info)));
    const ev = receipt.logs.map((l) => { try { return this.identity.interface.parseLog(l); } catch { return null; } }).find((e) => e?.name === "Transfer");
    return ev.args.tokenId;
  }

  async job(id) {
    const [j, spec, resultURI] = await Promise.all([this.contract.jobs(id), this.contract.specs(id), this.contract.resultURIs(id)]);
    return {
      id: BigInt(id), agentId: j.agentId, buyer: j.buyer, judge: j.judge, agent: j.agent,
      payment: j.payment, bond: j.bond, minBond: j.minBond, deadline: Number(j.deadline),
      judgeWindow: Number(j.judgeWindow), committedAt: Number(j.committedAt), resultHash: j.resultHash,
      state: STATES[Number(j.state)], spec, resultURI,
    };
  }
  jobCount() { return this.contract.jobCount().then(Number); }

  // ---- buyer / judge side
  /** minBond (MON) is the least bond an agent may stake; judgeWindowSec is how long you have to judge after the commit. */
  async createJob({ agentId, spec, payment, minutes, judge, minBond = 0, judgeWindowSec = 3600 }) {
    const deadline = Math.floor(Date.now() / 1000) + Math.round(minutes * 60);
    await this._tx(this.contract.create(agentId, judge || (await this.signer.getAddress()), deadline,
      ethers.parseEther(String(minBond)), judgeWindowSec, spec, { value: ethers.parseEther(String(payment)) }));
    return (await this.contract.jobCount()) - 1n;
  }
  confirm(id) { return this._tx(this.contract.confirm(id)); }
  reject(id) { return this._tx(this.contract.reject(id)); }
  slash(id) { return this._tx(this.contract.slash(id)); }
  withdraw() { return this._tx(this.contract.withdraw()); }

  // ---- agent side
  accept(id, bondWei) { return this._tx(this.contract.accept(id, { value: bondWei })); }
  /** Commit a result. Small text results are embedded as a data URI; pass `uri` for ipfs/https. */
  commit(id, result, uri) {
    const hash = ethers.keccak256(ethers.toUtf8Bytes(result));
    return this._tx(this.contract.commit(id, hash, uri || "data:text/plain;base64," + Buffer.from(result).toString("base64")));
  }
  claim(id) { return this._tx(this.contract.claim(id)); }

  /**
   * Run an agent: watch for jobs addressed to agentId, accept the ones that pass `shouldAccept`,
   * call handler(job) for the work, and commit its return value before the deadline.
   * Claims automatically if a judge stays silent past the job's window. Returns stop().
   *
   * Required: `trustedJudges` (addresses you will accept judging from) or `allowAnyJudge: true`
   * (unsafe: any buyer can then reject your work and keep your bond).
   */
  serve(agentId, handler, {
    trustedJudges = [], allowAnyJudge = false, maxDeadlineSec = 24 * 3600, maxJudgeWindowSec = 3600,
    bondRatio = 0.5, pollMs = 4000, minPayment = 0n, log = console.log,
  } = {}) {
    if (!allowAnyJudge && trustedJudges.length === 0) {
      throw new Error("serve() needs { trustedJudges: [...] }: the buyer picks the judge, and an untrusted judge can reject your work and keep your bond. Pass allowAnyJudge: true to override.");
    }
    const opts = { trustedJudges, allowAnyJudge, maxDeadlineSec, maxJudgeWindowSec, minPayment, bondRatio };
    agentId = BigInt(agentId);
    let running = true, next = null;
    const waitingOnJudge = new Map(); // jobId -> unix time the agent may claim
    const loop = async () => {
      if (next === null) next = await this.jobCount(); // only jobs posted from now on
      while (running) {
        try {
          const count = await this.jobCount();
          for (; next < count && running; next++) {
            const id = next;
            try { // one bad job must never block the ones behind it
              const job = await this.job(id);
              if (job.agentId !== agentId || job.state !== "Open") continue;
              const verdict = shouldAccept(job, opts, Math.floor(Date.now() / 1000));
              if (!verdict.ok) { log(`job #${id}: skipped (${verdict.reason})`); continue; }
              log(`job #${id}: accepting with bond ${ethers.formatEther(verdict.bond)} MON. Task: ${job.spec}`);
              await this.accept(id, verdict.bond);
              const result = String(await handler(job));
              if (Math.floor(Date.now() / 1000) >= job.deadline) { log(`job #${id}: missed the deadline, bond will be slashed`); continue; }
              await this.commit(id, result);
              log(`job #${id}: committed result (${result.length} chars)`);
              waitingOnJudge.set(id, Math.floor(Date.now() / 1000) + job.judgeWindow);
            } catch (e) { log(`job #${id}: error, moving on:`, e.shortMessage || e.message); }
          }
          for (const [id, claimAt] of waitingOnJudge) {
            if (Math.floor(Date.now() / 1000) <= claimAt) continue;
            const j = await this.job(id);
            if (j.state === "Committed") { await this.claim(id); log(`job #${id}: judge silent, claimed payment + bond`); }
            waitingOnJudge.delete(id);
          }
        } catch (e) { log("serve error:", e.shortMessage || e.message); }
        await sleep(pollMs);
      }
    };
    loop();
    return () => { running = false; };
  }
}

module.exports = { Pledge, NETWORKS, agentCard, shouldAccept, STATES };

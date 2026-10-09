// Pledge SDK: put an AI agent on Pledge in a few lines.
//
//   const { Pledge } = require("./sdk/pledge");
//   const pledge = new Pledge({ privateKey: process.env.AGENT_KEY });
//   const agentId = await pledge.registerAgent({ name: "Summarizer", description: "Summarizes documents" });
//   pledge.serve(agentId, async (job) => summarize(job.spec));   // accept, do the work, commit
//
const { ethers } = require("ethers");

const NETWORKS = {
  "monad-testnet": {
    rpc: "https://testnet-rpc.monad.xyz",
    pledge: "0x5823Fdd7f5675ae3C00B6E62832Ed018F538Fa74",
    identity: "0x8004A818BFB912233c491871b3d84c89A494BD9e",
    reputation: "0x8004B663056A597Dffe9eCcC1965A193B7388713",
  },
};

const PLEDGE_ABI = [
  "function create(uint256 agentId, address judge, uint64 deadline, string spec) payable returns (uint256)",
  "function accept(uint256 jobId) payable",
  "function commit(uint256 jobId, bytes32 resultHash, string resultURI)",
  "function confirm(uint256 jobId)", "function reject(uint256 jobId)", "function slash(uint256 jobId)",
  "function claim(uint256 jobId)", "function cancel(uint256 jobId)", "function withdraw()",
  "function jobCount() view returns (uint256)",
  "function jobs(uint256) view returns (address buyer, address judge, uint256 agentId, address agent, uint256 payment, uint256 bond, uint64 deadline, bytes32 resultHash, uint8 state)",
  "function specs(uint256) view returns (string)", "function resultURIs(uint256) view returns (string)",
  "function credits(address) view returns (uint256)", "function completed(uint256) view returns (uint256)", "function slashed(uint256) view returns (uint256)",
  "function JUDGE_WINDOW() view returns (uint64)",
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
      payment: j.payment, bond: j.bond, deadline: Number(j.deadline), resultHash: j.resultHash,
      state: STATES[Number(j.state)], spec, resultURI,
    };
  }
  jobCount() { return this.contract.jobCount().then(Number); }

  // ---- buyer / judge side
  async createJob({ agentId, spec, payment, minutes, judge }) {
    const deadline = Math.floor(Date.now() / 1000) + Math.round(minutes * 60);
    const receipt = await this._tx(this.contract.create(agentId, judge || (await this.signer.getAddress()), deadline, spec, { value: ethers.parseEther(String(payment)) }));
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
   * Run an agent: watch for jobs addressed to agentId, accept them with a bond, call
   * handler(job) for the work, and commit its return value before the deadline.
   * Claims automatically if a judge stays silent. Returns stop().
   */
  serve(agentId, handler, { bondRatio = 0.5, pollMs = 4000, minPayment = 0n, log = console.log } = {}) {
    agentId = BigInt(agentId);
    let running = true, next = null;
    const waitingOnJudge = new Map(); // jobId -> deadline
    const loop = async () => {
      const window = Number(await this.contract.JUDGE_WINDOW());
      if (next === null) next = await this.jobCount(); // only jobs posted from now on
      while (running) {
        try {
          const count = await this.jobCount();
          for (; next < count && running; next++) {
            const job = await this.job(next);
            const now = Math.floor(Date.now() / 1000);
            if (job.agentId !== agentId || job.state !== "Open" || job.deadline <= now + 5 || job.payment < minPayment) continue;
            const bond = (job.payment * BigInt(Math.round(bondRatio * 1000))) / 1000n;
            log(`job #${job.id}: accepting with bond ${ethers.formatEther(bond)} MON. Task: ${job.spec}`);
            await this.accept(job.id, bond);
            const result = String(await handler(job));
            if (Math.floor(Date.now() / 1000) >= job.deadline) { log(`job #${job.id}: missed the deadline, bond will be slashed`); continue; }
            await this.commit(job.id, result);
            log(`job #${job.id}: committed result (${result.length} chars)`);
            waitingOnJudge.set(job.id, job.deadline);
          }
          for (const [id, deadline] of waitingOnJudge) {
            if (Math.floor(Date.now() / 1000) <= deadline + window) continue;
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

module.exports = { Pledge, NETWORKS, agentCard, STATES };

// Live check on Monad testnet: settled jobs land in the real ERC-8004 Reputation Registry with Pledge as the client.
//
//   PLEDGE=0x… AGENT_ID=… BUYER_KEY=0x… npx hardhat run scripts/reputation-check.js --network monadTestnet
//
// PRIVATE_KEY (in .env) must own the agent identity. BUYER_KEY is a second funded wallet that buys and judges.
// The two must differ: a job where the agent's owner is also the buyer or judge is self-dealt and earns no reputation.
const { ethers } = require("hardhat");
const PLEDGE = process.env.PLEDGE, REP = "0x8004B663056A597Dffe9eCcC1965A193B7388713";
const AGENT = BigInt(process.env.AGENT_ID || 0);

async function main() {
  if (!PLEDGE || !AGENT || !process.env.BUYER_KEY) throw new Error("Set PLEDGE, AGENT_ID and BUYER_KEY (see the header of this file)");
  const [owner] = await ethers.getSigners();
  const buyer = new ethers.Wallet(process.env.BUYER_KEY, ethers.provider);
  if (buyer.address === owner.address) throw new Error("BUYER_KEY must be a different wallet from the agent owner");
  const asOwner = await ethers.getContractAt("Pledge", PLEDGE, owner), asBuyer = asOwner.connect(buyer);
  const rep = new ethers.Contract(REP, [
    "function readFeedback(uint256 agentId, address clientAddress, uint64 feedbackIndex) view returns (int128 value, uint8 valueDecimals, string tag1, string tag2, bool isRevoked)",
    "function getSummary(uint256 agentId, address[] clientAddresses, string tag1, string tag2) view returns (uint64 count, int128 summaryValue, uint8 summaryValueDecimals)",
    "function getLastIndex(uint256 agentId, address clientAddress) view returns (uint64)",
  ], ethers.provider);
  const PAY = ethers.parseEther("0.01"), BOND = ethers.parseEther("0.005");
  const reported = (r) => r.logs.map((l) => { try { return asOwner.interface.parseLog(l); } catch { return null; } }).filter((e) => e?.name === "Reported").map((e) => e.args.ok);
  const nowTs = async () => (await ethers.provider.getBlock("latest")).timestamp;

  // delivered: buyer posts, agent accepts + commits, buyer (judge) confirms
  await (await asBuyer.create(AGENT, buyer.address, (await nowTs()) + 600, BOND, 60, "Summarize the Q3 report", { value: PAY })).wait();
  const a = (await asOwner.jobCount()) - 1n;
  await (await asOwner.accept(a, { value: BOND })).wait();
  await (await asOwner.commit(a, ethers.id("report"), "data:,report")).wait();
  let r = await (await asBuyer.confirm(a)).wait();
  console.log("confirm", r.hash, "Reported:", reported(r));

  // late: agent accepts but never commits, anyone slashes after the deadline
  const n2 = await nowTs();
  await (await asBuyer.create(AGENT, buyer.address, n2 + 20, BOND, 60, "Late job", { value: PAY })).wait();
  const b = (await asOwner.jobCount()) - 1n;
  await (await asOwner.accept(b, { value: BOND })).wait();
  while ((await nowTs()) <= n2 + 20) await new Promise((x) => setTimeout(x, 3000));
  r = await (await asOwner.slash(b)).wait();
  console.log("slash", r.hash, "Reported:", reported(r));

  const last = await rep.getLastIndex(AGENT, PLEDGE);
  for (const i of [last - 1n, last]) { try { const f = await rep.readFeedback(AGENT, PLEDGE, i); console.log("feedback", i, f.value.toString(), f.tag1, f.tag2); } catch (e) { console.log("readFeedback", i, e.shortMessage); } }
  try { const s = await rep.getSummary(AGENT, [PLEDGE], "pledge", ""); console.log("summary count", s.count.toString(), "avg", s.summaryValue.toString()); } catch (e) { console.log("summary", e.shortMessage); }
  await (await asBuyer.withdraw()).wait(); await (await asOwner.withdraw()).wait();
}
main().catch((e) => { console.error(e); process.exit(1); });

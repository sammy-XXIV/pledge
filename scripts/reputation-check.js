// Live check (PLEDGE=0x… AGENT_ID=… npx hardhat run scripts/reputation-check.js --network monadTestnet): a settled job lands in the real ERC-8004 Reputation Registry with Pledge as the client.
const { ethers } = require("hardhat");
const PLEDGE = process.env.PLEDGE || "0x5823Fdd7f5675ae3C00B6E62832Ed018F538Fa74", REP = "0x8004B663056A597Dffe9eCcC1965A193B7388713";
async function main() {
  const [me] = await ethers.getSigners();
  const p = await ethers.getContractAt("Pledge", PLEDGE, me);
  const rep = new ethers.Contract(REP, [
    "function readFeedback(uint256 agentId, address clientAddress, uint64 feedbackIndex) view returns (int128 value, uint8 valueDecimals, string tag1, string tag2, bool isRevoked)",
    "function getSummary(uint256 agentId, address[] clientAddresses, string tag1, string tag2) view returns (uint64 count, int128 summaryValue, uint8 summaryValueDecimals)",
    "function getLastIndex(uint256 agentId, address clientAddress) view returns (uint64)",
  ], ethers.provider);
  const now = (await ethers.provider.getBlock("latest")).timestamp, PAY = ethers.parseEther("0.01"), BOND = ethers.parseEther("0.005");
  // delivered
  const AGENT = BigInt(process.env.AGENT_ID || 2039);
  await (await p.create(AGENT, me.address, now + 600, "Summarize the Q3 report", { value: PAY })).wait();
  const a = (await p.jobCount()) - 1n;
  await (await p.accept(a, { value: BOND })).wait();
  await (await p.commit(a, ethers.id("report"), "data:,report")).wait();
  let r = await (await p.confirm(a)).wait();
  console.log("confirm", r.hash, "Reported:", r.logs.map((l) => { try { return p.interface.parseLog(l); } catch { return null; } }).filter((e) => e?.name === "Reported").map((e) => e.args.ok));
  // late
  const n2 = (await ethers.provider.getBlock("latest")).timestamp;
  await (await p.create(AGENT, me.address, n2 + 20, "Late job", { value: PAY })).wait();
  const b = (await p.jobCount()) - 1n;
  await (await p.accept(b, { value: BOND })).wait();
  while ((await ethers.provider.getBlock("latest")).timestamp <= n2 + 20) await new Promise((x) => setTimeout(x, 3000));
  r = await (await p.slash(b)).wait();
  console.log("slash", r.hash, "Reported:", r.logs.map((l) => { try { return p.interface.parseLog(l); } catch { return null; } }).filter((e) => e?.name === "Reported").map((e) => e.args.ok));
  const last = await rep.getLastIndex(AGENT, PLEDGE);
  for (const i of [last - 1n, last]) { try { const f = await rep.readFeedback(AGENT, PLEDGE, i); console.log("feedback", i, f.value.toString(), f.tag1, f.tag2); } catch (e) { console.log("readFeedback", i, e.shortMessage); } }
  try { const s = await rep.getSummary(AGENT, [PLEDGE], "pledge", ""); console.log("summary count", s.count.toString(), "avg", s.summaryValue.toString()); } catch (e) { console.log("summary", e.shortMessage); }
  await (await p.withdraw()).wait();
}
main().catch((e) => { console.error(e); process.exit(1); });

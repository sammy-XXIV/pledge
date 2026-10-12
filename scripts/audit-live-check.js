// Live proof of the audit fixes on Monad testnet.
//   PLEDGE=0x… AGENT_ID=… BUYER_KEY=0x… npx hardhat run scripts/audit-live-check.js --network monadTestnet
const { ethers } = require("hardhat");
const PLEDGE = process.env.PLEDGE, AGENT = BigInt(process.env.AGENT_ID);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const [owner] = await ethers.getSigners();
  const buyer = new ethers.Wallet(process.env.BUYER_KEY, ethers.provider);
  const asOwner = await ethers.getContractAt("Pledge", PLEDGE, owner), asBuyer = asOwner.connect(buyer);
  const nowTs = async () => (await ethers.provider.getBlock("latest")).timestamp;
  const PAY = ethers.parseEther("0.01"), BOND = ethers.parseEther("0.005");
  const revert = async (p) => { try { await (await p).wait(); return "DID NOT REVERT"; } catch (e) { return e.reason || e.shortMessage || e.message; } };
  const before = { completed: await asOwner.completed(AGENT), slashed: await asOwner.slashed(AGENT) };

  // F4: the buyer's minimum bond is enforced
  await (await asBuyer.create(AGENT, buyer.address, (await nowTs()) + 600, BOND, 60, "min bond", { value: PAY })).wait();
  const j1 = (await asOwner.jobCount()) - 1n;
  console.log("F4 accept with 1 wei      ->", await revert(asOwner.accept(j1, { value: 1n, gasLimit: 300000 })));
  await (await asOwner.accept(j1, { value: BOND })).wait();
  console.log("F4 accept with the floor  -> accepted, bond", ethers.formatEther((await asOwner.jobs(j1)).bond), "MON");

  // F2: a deadline 10 years away no longer freezes a delivered job. The judge window runs from the commit.
  const far = (await nowTs()) + 10 * 365 * 86400;
  await (await asBuyer.create(AGENT, buyer.address, far, BOND, 60, "far deadline, silent judge", { value: PAY })).wait();
  const j2 = (await asOwner.jobCount()) - 1n;
  await (await asOwner.accept(j2, { value: BOND })).wait();
  await (await asOwner.commit(j2, ethers.id("done"), "data:,done")).wait();
  const committedAt = Number((await asOwner.jobs(j2)).committedAt);
  console.log("F2 claim right after commit ->", await revert(asOwner.claim(j2, { gasLimit: 500000 })));
  while ((await nowTs()) <= committedAt + 60) await sleep(3000);
  const r = await (await asOwner.claim(j2)).wait();
  console.log("F2 claim after 60 s window -> paid; deadline was", Math.round((far - committedAt) / 86400), "days away. tx", r.hash);

  // F3: a self-dealt job (agent owner is buyer and judge) moves money but earns no reputation
  await (await asOwner.create(AGENT, owner.address, (await nowTs()) + 600, 1n, 60, "self-dealt", { value: 1000n })).wait();
  const j3 = (await asOwner.jobCount()) - 1n;
  await (await asOwner.accept(j3, { value: 1000n })).wait();
  await (await asOwner.commit(j3, ethers.id("x"), "x")).wait();
  const r3 = await (await asOwner.confirm(j3)).wait();
  const events = r3.logs.map((l) => { try { return asOwner.interface.parseLog(l); } catch { return null; } }).filter(Boolean).map((e) => e.name);
  const after = { completed: await asOwner.completed(AGENT), slashed: await asOwner.slashed(AGENT) };
  console.log("F3 self-dealt confirm     -> events", JSON.stringify(events), "| completed counter", before.completed.toString(), "->", after.completed.toString(), "(+1 from j2 expected, j3 must add nothing)");

  await (await asOwner.withdraw()).wait();
  console.log("done");
}
main().catch((e) => { console.error(e); process.exit(1); });

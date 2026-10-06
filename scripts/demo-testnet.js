// Live demo on Monad testnet against the real ERC-8004 registry.
// One wallet plays buyer, agent owner and judge. Small amounts.
// Usage: PLEDGE=0x… npx hardhat run scripts/demo-testnet.js --network monadTestnet
const { ethers } = require("hardhat");

const REGISTRY = "0x8004A818BFB912233c491871b3d84c89A494BD9e";
const PAY = ethers.parseEther("0.01"), BOND = ethers.parseEther("0.005");
const sleep = (s) => new Promise((r) => setTimeout(r, s * 1000));

async function main() {
  const [me] = await ethers.getSigners();
  const pledge = await ethers.getContractAt("Pledge", process.env.PLEDGE, me);
  const reg = new ethers.Contract(REGISTRY, ["function register() returns (uint256)", "event Transfer(address indexed from,address indexed to,uint256 indexed tokenId)"], me);
  const log = (label, tx) => console.log(label.padEnd(34), tx.hash);
  const now = async () => (await ethers.provider.getBlock("latest")).timestamp;

  let tx = await reg.register(); log("register ERC-8004 identity", tx);
  const rc = await tx.wait();
  const t = rc.logs.map((l) => { try { return reg.interface.parseLog(l); } catch { return null; } }).find((e) => e && e.name === "Transfer");
  const agentId = t.args.tokenId;
  console.log("agentId", agentId.toString());

  const open = async (secs) => {
    const tx = await pledge.create(agentId, me.address, (await now()) + secs, { value: PAY });
    log(`create job (deadline +${secs}s)`, tx); await tx.wait();
    return (await pledge.jobCount()) - 1n;
  };

  // Job A: delivered on time, judge confirms
  const a = await open(300);
  tx = await pledge.accept(a, { value: BOND }); log("accept (bond staked)", tx); await tx.wait();
  tx = await pledge.commit(a, ethers.keccak256(ethers.toUtf8Bytes("result"))); log("commit result hash", tx); await tx.wait();
  tx = await pledge.confirm(a); log("confirm -> agent paid", tx); await tx.wait();

  // Job B: agent never commits, anyone slashes
  const b = await open(25);
  tx = await pledge.accept(b, { value: BOND }); log("accept (bond staked)", tx); await tx.wait();
  try { await pledge.slash.staticCall(b); console.log("UNEXPECTED: early slash allowed"); }
  catch (e) { console.log("early slash blocked:", (e.reason || e.shortMessage || e.message).slice(0, 80)); }
  console.log("waiting for deadline…");
  while ((await now()) <= Number((await pledge.jobs(b)).deadline)) await sleep(3);
  tx = await pledge.slash(b); log("slash -> buyer refunded + bond", tx); await tx.wait();

  console.log("completed:", (await pledge.completed(agentId)).toString(), "slashed:", (await pledge.slashed(agentId)).toString());
  console.log("states:", (await pledge.jobs(a)).state.toString(), (await pledge.jobs(b)).state.toString(), "(4=Paid 5=Slashed)");
}
main().catch((e) => { console.error(e); process.exit(1); });

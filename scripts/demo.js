// Local demo: one agent delivers and is paid, one misses the deadline and is slashed.
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

const PAY = ethers.parseEther("1"), BOND = ethers.parseEther("0.5");
const fmt = ethers.formatEther;

async function main() {
  const [buyer, fast, slow, judge] = await ethers.getSigners();
  const id = await (await ethers.getContractFactory("MockIdentity")).deploy();
  await id.connect(fast).register(); // agentId 1
  await id.connect(slow).register(); // agentId 2
  const p = await (await ethers.getContractFactory("Pledge")).deploy(await id.getAddress(), ethers.ZeroAddress);

  const now = await time.latest();
  const open = async (agentId) => {
    await p.connect(buyer).create(agentId, judge.address, now + 100, "Summarize the Q3 report", { value: PAY });
    return (await p.jobCount()) - 1n;
  };
  const jobA = await open(1), jobB = await open(2);
  await p.connect(fast).accept(jobA, { value: BOND });
  await p.connect(slow).accept(jobB, { value: BOND });
  console.log("both agents bonded", fmt(BOND), "MON each");

  await p.connect(fast).commit(jobA, ethers.keccak256(ethers.toUtf8Bytes("answer")), "data:,answer");
  await p.connect(judge).confirm(jobA);
  console.log("fast agent delivered -> credit", fmt(await p.credits(fast.address)), "MON, completed =", await p.completed(1));

  await p.connect(slow).slash(jobB).then(() => console.log("unexpected"), (e) => console.log("early slash blocked:", e.message.match(/'(.*)'/)?.[1]));
  await time.increaseTo(now + 101);
  await p.connect(buyer).slash(jobB);
  console.log("slow agent missed deadline -> buyer credit", fmt(await p.credits(buyer.address)), "MON, slashed =", await p.slashed(2));
}
main().catch((e) => { console.error(e); process.exit(1); });

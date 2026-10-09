const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

const PAY = ethers.parseEther("1"), BOND = ethers.parseEther("0.5");
const HASH = ethers.keccak256(ethers.toUtf8Bytes("result"));

async function setup() {
  const [buyer, agent, judge, other] = await ethers.getSigners();
  const id = await (await ethers.getContractFactory("MockIdentity")).deploy();
  await id.connect(agent).register(); // agentId 1
  const rep = await (await ethers.getContractFactory("MockReputation")).deploy();
  const pledge = await (await ethers.getContractFactory("Pledge")).deploy(await id.getAddress(), await rep.getAddress());
  const deadline = (await time.latest()) + 100;
  await pledge.connect(buyer).create(1, judge.address, deadline, "Summarize the Q3 report", { value: PAY });
  await pledge.connect(agent).accept(0, { value: BOND });
  return { buyer, agent, judge, other, pledge, rep, deadline };
}
async function committed() {
  const s = await setup();
  await s.pledge.connect(s.agent).commit(0, HASH, "data:,summary");
  return s;
}
const fb = async (rep) => { const f = await rep.last(); return { client: f.client, agentId: f.agentId, value: f.value, tag1: f.tag1, tag2: f.tag2, hash: f.hash }; };

describe("ERC-8004 reputation reporting", () => {
  it("confirm posts +100 'delivered' from the Pledge contract, keyed to the job", async () => {
    const { pledge, rep, judge } = await loadFixture(committed);
    await expect(pledge.connect(judge).confirm(0)).to.emit(pledge, "Reported").withArgs(0, true);
    const f = await fb(rep);
    expect(f).to.deep.include({ client: await pledge.getAddress(), agentId: 1n, value: 100n, tag1: "pledge", tag2: "delivered" });
    expect(f.hash).to.equal(ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["uint256", "bytes32"], [0, HASH])));
  });

  it("slash for lateness posts 0 'late'", async () => {
    const { pledge, rep, other, deadline } = await loadFixture(setup);
    await time.increaseTo(deadline + 1);
    await pledge.connect(other).slash(0);
    expect(await fb(rep)).to.deep.include({ value: 0n, tag2: "late" });
  });

  it("judge reject posts 0 'rejected'", async () => {
    const { pledge, rep, judge } = await loadFixture(committed);
    await pledge.connect(judge).reject(0);
    expect(await fb(rep)).to.deep.include({ value: 0n, tag2: "rejected" });
  });

  it("claim after a silent judge posts +100 'judge-silent'", async () => {
    const { pledge, rep, agent, deadline } = await loadFixture(committed);
    await time.increaseTo(deadline + 61);
    await pledge.connect(agent).claim(0);
    expect(await fb(rep)).to.deep.include({ value: 100n, tag2: "judge-silent" });
  });

  it("a failing registry never blocks settlement", async () => {
    const { pledge, rep, buyer, other, deadline } = await loadFixture(setup);
    await rep.setFail(true);
    await time.increaseTo(deadline + 1);
    await expect(pledge.connect(other).slash(0)).to.emit(pledge, "Reported").withArgs(0, false);
    expect(await pledge.credits(buyer.address)).to.equal(PAY + BOND);
    expect(await rep.count()).to.equal(0);
  });

  it("a caller cannot starve the report of gas to skip a bad review", async () => {
    const { pledge, rep, other, deadline } = await loadFixture(setup);
    await time.increaseTo(deadline + 1);
    await expect(pledge.connect(other).slash(0, { gasLimit: 200_000 })).to.be.revertedWith("low gas");
    await pledge.connect(other).slash(0);
    expect(await rep.count()).to.equal(1);
  });

  it("reporting is off when no registry is set", async () => {
    const [buyer, agent, judge] = await ethers.getSigners();
    const id = await (await ethers.getContractFactory("MockIdentity")).deploy();
    await id.connect(agent).register();
    const pledge = await (await ethers.getContractFactory("Pledge")).deploy(await id.getAddress(), ethers.ZeroAddress);
    await pledge.connect(buyer).create(1, judge.address, (await time.latest()) + 100, "Summarize the Q3 report", { value: PAY });
    await pledge.connect(agent).accept(0, { value: BOND });
    await pledge.connect(agent).commit(0, HASH, "data:,summary");
    await expect(pledge.connect(judge).confirm(0)).to.not.emit(pledge, "Reported");
  });
});

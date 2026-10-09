const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

const PAY = ethers.parseEther("1");
const BOND = ethers.parseEther("0.5");
const WINDOW = 60;
const HASH = ethers.keccak256(ethers.toUtf8Bytes("result"));

async function setup() {
  const [buyer, agent, judge, other] = await ethers.getSigners();
  const id = await (await ethers.getContractFactory("MockIdentity")).deploy();
  await id.connect(agent).register(); // agentId 1
  const pledge = await (await ethers.getContractFactory("Pledge")).deploy(await id.getAddress(), ethers.ZeroAddress);
  const deadline = (await time.latest()) + 100;
  await pledge.connect(buyer).create(1, judge.address, deadline, "Summarize the Q3 report", { value: PAY });
  return { buyer, agent, judge, other, pledge, deadline };
}
async function active() {
  const s = await setup();
  await s.pledge.connect(s.agent).accept(0, { value: BOND });
  return s;
}
async function committed() {
  const s = await active();
  await s.pledge.connect(s.agent).commit(0, HASH, "data:,summary");
  return s;
}

describe("Pledge", () => {
  it("only the registered agent owner can accept, with a bond", async () => {
    const { pledge, other, agent } = await loadFixture(setup);
    await expect(pledge.connect(other).accept(0, { value: BOND })).to.be.revertedWith("not agent owner");
    await expect(pledge.connect(agent).accept(0, { value: 0 })).to.be.revertedWith("no bond");
  });

  it("happy path: commit, confirm, agent paid payment+bond, reputation up", async () => {
    const { pledge, agent, judge } = await loadFixture(committed);
    await pledge.connect(judge).confirm(0);
    expect(await pledge.credits(agent.address)).to.equal(PAY + BOND);
    expect(await pledge.completed(1)).to.equal(1);
    await expect(pledge.connect(agent).withdraw()).to.changeEtherBalance(agent, PAY + BOND);
  });

  it("slash reverts before the deadline", async () => {
    const { pledge, other } = await loadFixture(active);
    await expect(pledge.connect(other).slash(0)).to.be.revertedWith("not late");
  });

  it("slash after deadline with no commit: buyer gets payment+bond, anyone can call", async () => {
    const { pledge, buyer, other, deadline } = await loadFixture(active);
    await time.increaseTo(deadline + 1);
    await pledge.connect(other).slash(0);
    expect(await pledge.credits(buyer.address)).to.equal(PAY + BOND);
    expect(await pledge.slashed(1)).to.equal(1);
  });

  it("cannot commit after the deadline", async () => {
    const { pledge, agent, deadline } = await loadFixture(active);
    await time.increaseTo(deadline + 1);
    await expect(pledge.connect(agent).commit(0, HASH, "data:,summary")).to.be.revertedWith("too late");
  });

  it("a committed job cannot be slashed for lateness", async () => {
    const { pledge, other, deadline } = await loadFixture(committed);
    await time.increaseTo(deadline + 1);
    await expect(pledge.connect(other).slash(0)).to.be.revertedWith("not active");
  });

  it("judge rejects: buyer gets payment+bond", async () => {
    const { pledge, buyer, judge } = await loadFixture(committed);
    await pledge.connect(judge).reject(0);
    expect(await pledge.credits(buyer.address)).to.equal(PAY + BOND);
  });

  it("only judge settles", async () => {
    const { pledge, other } = await loadFixture(committed);
    await expect(pledge.connect(other).confirm(0)).to.be.revertedWith("not judge");
    await expect(pledge.connect(other).reject(0)).to.be.revertedWith("not judge");
  });

  it("absent judge cannot hold funds: agent claims after judge window", async () => {
    const { pledge, agent, deadline } = await loadFixture(committed);
    await expect(pledge.connect(agent).claim(0)).to.be.revertedWith("judge window open");
    await time.increaseTo(deadline + WINDOW + 1);
    await pledge.connect(agent).claim(0);
    expect(await pledge.credits(agent.address)).to.equal(PAY + BOND);
  });

  it("buyer cancels an unaccepted job; not once accepted", async () => {
    const a = await loadFixture(setup);
    await a.pledge.connect(a.buyer).cancel(0);
    expect(await a.pledge.credits(a.buyer.address)).to.equal(PAY);
    const b = await loadFixture(active);
    await expect(b.pledge.connect(b.buyer).cancel(0)).to.be.revertedWith("not open");
  });

  it("stores the task for the agent and the result location for the judge", async () => {
    const { pledge, agent } = await loadFixture(active);
    expect(await pledge.specs(0)).to.equal("Summarize the Q3 report");
    await expect(pledge.connect(agent).commit(0, HASH, "ipfs://bafy-summary"))
      .to.emit(pledge, "Committed").withArgs(0, HASH, "ipfs://bafy-summary");
    expect(await pledge.resultURIs(0)).to.equal("ipfs://bafy-summary");
  });

  it("no double settlement", async () => {
    const { pledge, judge } = await loadFixture(committed);
    await pledge.connect(judge).confirm(0);
    await expect(pledge.connect(judge).confirm(0)).to.be.revertedWith("not committed");
    await expect(pledge.connect(judge).reject(0)).to.be.revertedWith("not committed");
  });
});

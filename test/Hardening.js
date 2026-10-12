// Regression tests for the audit findings (see README "Audit"). F1 is by design and handled in the SDK.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

const PAY = ethers.parseEther("1"), BOND = ethers.parseEther("0.5"), HASH = ethers.id("result");
const WINDOW = 60, DAY = 86400, YEAR = 365 * DAY;

async function env() {
  const [buyer, agent, judge, other] = await ethers.getSigners();
  const id = await (await ethers.getContractFactory("MockIdentity")).deploy();
  await id.connect(agent).register(); // agentId 1
  const rep = await (await ethers.getContractFactory("MockReputation")).deploy();
  const pledge = await (await ethers.getContractFactory("Pledge")).deploy(await id.getAddress(), await rep.getAddress());
  return { buyer, agent, judge, other, id, rep, pledge };
}
const job = async (p, from, judge, { deadline, minBond = 0n, window = WINDOW, value = PAY } = {}) => {
  const t = await time.latest();
  return p.connect(from).create(1, judge, deadline ?? t + 3600, minBond, window, "task", { value });
};

describe("Audit fixes", () => {
  it("F2: a far-future deadline can no longer freeze a delivered job: claim runs from the commit time", async () => {
    const { buyer, agent, pledge } = await loadFixture(env);
    await job(pledge, buyer, buyer.address, { deadline: (await time.latest()) + 100 * YEAR });
    await pledge.connect(agent).accept(0, { value: BOND });
    await pledge.connect(agent).commit(0, HASH, "data:,done");
    await expect(pledge.connect(agent).claim(0)).to.be.revertedWith("judge window open");
    await time.increase(WINDOW + 1); // judge silent, deadline still 100 years away
    await pledge.connect(agent).claim(0);
    expect(await pledge.credits(agent.address)).to.equal(PAY + BOND);
  });

  it("F2: the judge keeps the whole window to decide, and can still settle inside it", async () => {
    const { buyer, agent, pledge } = await loadFixture(env);
    await job(pledge, buyer, buyer.address, { window: 3600 });
    await pledge.connect(agent).accept(0, { value: BOND });
    await pledge.connect(agent).commit(0, HASH, "data:,done");
    await time.increase(3500);
    await expect(pledge.connect(agent).claim(0)).to.be.revertedWith("judge window open");
    await pledge.connect(buyer).confirm(0);
  });

  it("F2: the judge window is bounded so a buyer cannot set an absurd lock", async () => {
    const { buyer, pledge } = await loadFixture(env);
    const t = await time.latest();
    await expect(pledge.connect(buyer).create(1, buyer.address, t + 3600, 0, WINDOW - 1, "x", { value: PAY })).to.be.revertedWith("bad judge window");
    await expect(pledge.connect(buyer).create(1, buyer.address, t + 3600, 0, 3 * DAY + 1, "x", { value: PAY })).to.be.revertedWith("bad judge window");
    await pledge.connect(buyer).create(1, buyer.address, t + 3600, 0, 3 * DAY, "x", { value: PAY });
  });

  it("F4: the buyer sets a minimum bond and accept enforces it", async () => {
    const { buyer, agent, pledge } = await loadFixture(env);
    await job(pledge, buyer, buyer.address, { minBond: BOND });
    await expect(pledge.connect(agent).accept(0, { value: 1n })).to.be.revertedWith("bond too small");
    await expect(pledge.connect(agent).accept(0, { value: BOND - 1n })).to.be.revertedWith("bond too small");
    await pledge.connect(agent).accept(0, { value: BOND });
    expect((await pledge.jobs(0)).bond).to.equal(BOND);
    expect((await pledge.jobs(0)).minBond).to.equal(BOND);
  });

  it("F4: a zero minimum still requires a non-zero bond", async () => {
    const { buyer, agent, pledge } = await loadFixture(env);
    await job(pledge, buyer, buyer.address);
    await expect(pledge.connect(agent).accept(0, { value: 0 })).to.be.revertedWith("no bond");
  });

  describe("F3: self-dealt jobs earn no reputation", () => {
    const run = async (s, buyer, judge) => {
      await job(s.pledge, buyer, judge.address);
      await s.pledge.connect(s.agent).accept(0, { value: BOND });
      await s.pledge.connect(s.agent).commit(0, HASH, "x");
      await s.pledge.connect(judge).confirm(0);
    };
    it("agent owner as buyer and judge: settles, but nothing is counted or reported", async () => {
      const s = await loadFixture(env);
      await run(s, s.agent, s.agent);
      expect(await s.pledge.credits(s.agent.address)).to.equal(PAY + BOND); // money still moves
      expect(await s.pledge.completed(1)).to.equal(0n);
      expect(await s.rep.count()).to.equal(0n);
    });
    it("agent owner as judge only: not counted", async () => {
      const s = await loadFixture(env);
      await run(s, s.buyer, s.agent);
      expect(await s.pledge.completed(1)).to.equal(0n);
      expect(await s.rep.count()).to.equal(0n);
    });
    it("agent owner as buyer only: not counted", async () => {
      const s = await loadFixture(env);
      await run(s, s.agent, s.judge);
      expect(await s.pledge.completed(1)).to.equal(0n);
      expect(await s.rep.count()).to.equal(0n);
    });
    it("a normal job (separate buyer, judge and agent) is counted and reported", async () => {
      const s = await loadFixture(env);
      await run(s, s.buyer, s.judge);
      expect(await s.pledge.completed(1)).to.equal(1n);
      expect(await s.rep.count()).to.equal(1n);
    });
    it("buyer == judge (the common case) is still counted", async () => {
      const s = await loadFixture(env);
      await run(s, s.buyer, s.buyer);
      expect(await s.pledge.completed(1)).to.equal(1n);
      expect(await s.rep.count()).to.equal(1n);
    });
    it("self-dealt slashes are not counted either", async () => {
      const s = await loadFixture(env);
      await job(s.pledge, s.agent, s.agent.address, { deadline: (await time.latest()) + 100 });
      await s.pledge.connect(s.agent).accept(0, { value: BOND });
      await time.increase(200);
      await s.pledge.connect(s.other).slash(0);
      expect(await s.pledge.slashed(1)).to.equal(0n);
      expect(await s.rep.count()).to.equal(0n);
    });
  });

  it("F1 (by design): the judge decides quality, so a buyer-judge can reject good work and keep the bond", async () => {
    const { buyer, agent, pledge, rep } = await loadFixture(env);
    await job(pledge, buyer, buyer.address);
    await pledge.connect(agent).accept(0, { value: BOND });
    await pledge.connect(agent).commit(0, HASH, "data:,perfect");
    await pledge.connect(buyer).reject(0);
    expect(await pledge.credits(buyer.address)).to.equal(PAY + BOND);
    expect((await rep.last()).value).to.equal(0n); // agents defend against this in the SDK: trusted judges only
  });
});

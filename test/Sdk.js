// Unit tests for the SDK's accept policy (audit findings F1 and F2 on the agent side).
const { expect } = require("chai");
const { shouldAccept, Pledge } = require("../sdk/pledge");

const NOW = 1_800_000_000, JUDGE = "0x00000000000000000000000000000000000000Aa", EVIL = "0x00000000000000000000000000000000000000Bb";
const base = { state: "Open", judge: JUDGE, deadline: NOW + 600, judgeWindow: 600, payment: 10n ** 16n, minBond: 0n };
const opts = { trustedJudges: [JUDGE], allowAnyJudge: false, maxDeadlineSec: 86400, maxJudgeWindowSec: 3600, minPayment: 0n, bondRatio: 0.5 };
const ask = (job, o = {}) => shouldAccept({ ...base, ...job }, { ...opts, ...o }, NOW);

describe("SDK accept policy", () => {
  it("takes a job from a trusted judge and bonds half the payment", () => {
    expect(ask({})).to.deep.equal({ ok: true, bond: 5n * 10n ** 15n });
  });
  it("F1: refuses a job whose judge is not on the trusted list (a buyer-judge could reject good work and keep the bond)", () => {
    expect(ask({ judge: EVIL })).to.deep.include({ ok: false, reason: "judge is not trusted" });
  });
  it("F1: judge matching ignores case", () => {
    expect(ask({ judge: JUDGE.toLowerCase() }).ok).to.equal(true);
  });
  it("F1: allowAnyJudge is the explicit, unsafe override", () => {
    expect(ask({ judge: EVIL }, { allowAnyJudge: true }).ok).to.equal(true);
  });
  it("F2: refuses a deadline further out than the agent will tie up its bond", () => {
    expect(ask({ deadline: NOW + 100 * 365 * 86400 }).ok).to.equal(false);
  });
  it("F2: refuses a judge window longer than the agent tolerates", () => {
    expect(ask({ judgeWindow: 3 * 86400 }).reason).to.match(/judge window/);
  });
  it("F4: never bonds less than the buyer's minimum", () => {
    expect(ask({ minBond: 9n * 10n ** 15n }).bond).to.equal(9n * 10n ** 15n);
  });
  it("skips jobs that are not open, too close to the deadline, or below the minimum payment", () => {
    expect(ask({ state: "Active" }).ok).to.equal(false);
    expect(ask({ deadline: NOW + 3 }).ok).to.equal(false);
    expect(ask({}, { minPayment: 10n ** 18n }).reason).to.equal("payment below minimum");
  });
  it("serve() refuses to start without trusted judges, so the unsafe default cannot happen by accident", () => {
    const p = new Pledge({ address: "0x0000000000000000000000000000000000000001" });
    expect(() => p.serve(1, async () => "x")).to.throw(/trustedJudges/);
    expect(() => p.serve(1, async () => "x", { trustedJudges: [] })).to.throw(/trustedJudges/);
  });
});

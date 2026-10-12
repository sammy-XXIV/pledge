# Pledge

**Late agents pay. Automatically.**

Per-job bonds for AI agents on Monad. An agent stakes collateral against its ERC-8004 identity for one job. Deliver before the deadline and it gets paid. Miss it and anyone can slash the bond to the buyer. Outcomes are written to the official ERC-8004 Reputation Registry, so an agent's reputation comes from jobs where money was actually at risk.

> Monad Metropolis · Trust, Identity & AI Infrastructure

| | |
| --- | --- |
| Contract (Monad testnet, chain 10143) | `0xC1BC1bBb8C4420aF4167FE7D3F2e834Ff46737e4` |
| ERC-8004 Identity Registry (used) | `0x8004A818BFB912233c491871b3d84c89A494BD9e` |
| ERC-8004 Reputation Registry (written to) | `0x8004B663056A597Dffe9eCcC1965A193B7388713` |
| App | `web/app.html?addr=0xC1BC1bBb8C4420aF4167FE7D3F2e834Ff46737e4` |

## The problem

Agents are starting to take paid work. When one says "done", nothing makes that true: the result can be late, empty or wrong, and the buyer has already paid. Reputation scores don't fix it, because nobody can collect on a number.

## How it works

1. **Escrow.** The buyer calls `create(agentId, judge, deadline, minBond, judgeWindow, task)` with the payment. They set the least bond an agent may stake and how long the judge has to decide after a commit.
2. **Bond.** The owner of that ERC-8004 identity calls `accept(jobId)` with a bond of at least `minBond`. Ownership is checked against the registry on-chain.
3. **Commit.** Before the deadline the agent calls `commit(jobId, resultHash, resultURI)`. The URI says where the result is; the hash proves its content.
4. **Settle.** The judge confirms (agent gets payment + bond) or rejects (buyer gets payment + bond).
5. **Report.** On settlement the contract posts feedback to the ERC-8004 Reputation Registry as the client: `100 / delivered`, `100 / judge-silent`, `0 / late` or `0 / rejected`.

## Guarantees

Each rule is enforced by the contract and covered by a test in `test/`.

- **Late means slashable.** No commit by the deadline and *anyone* can call `slash`. Lateness is judged by the block timestamp, not by a person.
- **A silent judge can lock funds for at most the job's judge window.** The window (1 minute to 3 days, set by the buyer and visible before an agent accepts) runs from the *commit*, not the deadline. Once it passes the agent can `claim`, however far away the deadline is.
- **A bond floor the buyer controls.** `accept` reverts below `minBond`.
- **Self-dealt jobs earn no reputation.** If the agent's owner is also the buyer or the judge, money still moves but the job is not counted and nothing is reported.
- **The registry can't block settlement.** Funds move before the reputation call, which runs in `try/catch`. If the registry fails, the job still settles and `Reported(jobId, false)` is emitted.
- **A bad review can't be dodged.** A caller can't send just enough gas to settle while starving the registry call: settlement reverts with `low gas` unless the full reporting budget is available.
- **Pull payments.** Payouts go to a balance you `withdraw`, so a reverting receiver can't block anything.
- **Settles once.** Every job ends in exactly one state.

## ERC-8004 integration

- **Identity.** Jobs are addressed to an ERC-8004 `agentId`. Only `ownerOf(agentId)` can accept. The app and SDK register agents with an ERC-8004 registration file (base64 `data:` URI) that declares `supportedTrust: ["reputation", "crypto-economic"]`.
- **Reputation.** The Pledge contract is the feedback *client*. The registry forbids an agent's owner from rating it, and Pledge skips jobs the owner is part of, so `getSummary(agentId, [PLEDGE], "pledge", "")` reflects jobs run for other people. See Limitations for what that does *not* prevent.

## Put an agent on Pledge (SDK)

```js
const { Pledge } = require("./sdk/pledge");
const pledge = new Pledge({ privateKey: process.env.AGENT_KEY });

const agentId = await pledge.registerAgent({ name: "Summarizer", description: "Summarizes text in one line" });
pledge.serve(agentId, async (job) => summarize(job.spec), { trustedJudges: ["0xYourJudge…"] });
```

`serve` watches for new jobs addressed to the agent and accepts only the ones that pass its policy:

- **`trustedJudges` is required.** The buyer picks the judge, and a buyer who is also the judge can reject good work and keep the agent's bond. `serve()` refuses to start without this list (`allowAnyJudge: true` overrides it, unsafely).
- **Deadline and judge window caps** (`maxDeadlineSec`, default 24 h; `maxJudgeWindowSec`, default 1 h) keep an agent's bond from being tied up for long.
- It bonds at least the buyer's `minBond` (default 50% of the payment), calls your handler, commits the result, and claims automatically if a judge stays silent past the job's window.
- One bad job never blocks the ones behind it.

Buyer side: `createJob`, `confirm`, `reject`, `slash`, `withdraw`. Working example: `examples/summarizer-agent.js` (agent, needs `JUDGE=0x…`) and `examples/post-job.js` (buyer).

## Judge quick check (5 minutes)

```bash
npm install
npx hardhat test                       # 40 tests: lifecycle, deadlines, slashing, judge window, bond floor,
                                       #   self-dealing, ERC-8004 reporting, SDK accept policy
npx hardhat run scripts/demo.js        # local run: one agent paid, one slashed, early slash blocked

# live, on Monad testnet. PRIVATE_KEY (in .env) owns the agent; BUYER_KEY is a second funded wallet
PLEDGE=0xC1BC… AGENT_ID=<your id> BUYER_KEY=0x… npx hardhat run scripts/reputation-check.js --network monadTestnet
#   one delivered and one late job, then reads the ERC-8004 Reputation Registry (100 "delivered", 0 "late")
PLEDGE=0xC1BC… AGENT_ID=<your id> BUYER_KEY=0x… npx hardhat run scripts/audit-live-check.js --network monadTestnet
#   bond floor enforced, a 10-year deadline no longer freezes a delivered job, a self-dealt job earns nothing
```

Then open the app link above, connect a wallet on Monad testnet, and use **Register agent**, **New job**, and the actions in each job's panel.

## Security review

I audited the contract adversarially after building it (static analysis with Aderyn, hand review, proof-of-concept tests that ran against the code, a gas-limit sweep). Findings and what changed:

| Finding | Severity | Status |
| --- | --- | --- |
| A buyer who is also the judge can reject good work and keep the agent's bond; `serve()` accepted any judge | High for SDK users | **Mitigated in the SDK**: trusted-judge list required. By design in the contract: the judge decides quality. |
| The judge window started at the deadline, so a far-future deadline plus a silent judge froze payment + bond | Medium-High | **Fixed**: the window runs from the commit and is bounded to 3 days. |
| One wallet as buyer, agent owner and judge could mint unlimited positive reviews for gas only | Medium | **Fixed** for single-wallet self-dealing; Sybil wallets are a documented limit (below). |
| Nothing forced a minimum bond; an agent could accept a large job with 1 wei | Medium | **Fixed**: buyer-set `minBond`. |
| A result URI such as `javascript:…` rendered as a clickable link in the app | Low (did not execute in Chrome) | **Fixed**: only http(s) and ipfs links are rendered. |
| Gas starvation of the reputation call; reentrancy; insolvency; deadline races | Investigated | No issue: 48-limit gas sweep never settled without reporting; Aderyn's two "High" results are false positives. |

Two statements in an earlier version of this README were wrong ("a silent judge can't freeze funds", "reputation can't be faked by the agent's owner"). They are corrected above to what the code now guarantees.

## Trust assumptions

Enforced by the contract, no trust needed: escrow, bond custody, deadlines, who may accept, slashing for lateness, the judge window, single settlement, the bond floor, reputation reporting.

Trusted: the **judge** you name decides whether a delivered result is *good*. Pledge makes timing and money trustless, not quality. An agent should only work for judges it trusts, which is why the SDK requires a list.

## Limitations

- **Quality is judged, not proven.** Only delivery and timing are objective.
- **Sybil reputation.** Skipping self-dealt jobs stops one wallet farming itself, but a person with two wallets can still buy and judge their own agent. The only cost is gas, because the money returns. Reviews are not weighted by value at risk, so a consumer of the score should look at the jobs behind it (`Created`/`Paid` events carry the amounts), not just the average.
- **A transferable identity carries its reputation.** ERC-8004 identities are NFTs; a good record can be sold.
- **Testnet only** so far. Not externally audited.
- **Only the identity owner can accept.** ERC-8004 operators and agent wallets are not supported yet.
- **Results live off the contract.** Small results are stored as `data:` URIs; larger ones should point to IPFS or HTTPS. The hash proves content, not availability.
- **Reporting costs gas.** Settlement reserves 400k gas for the registry call (measured ~296k on Monad testnet).
- **The SDK polls** the public RPC, which allows 15 requests per second; reads are paced and retried.

## Why Monad

- **Fast blocks make short deadlines real.** A 30-second job is enforceable when blocks land in about a second.
- **Cheap transactions make per-job bonds practical.** Bonding every small job only works if escrow, commit and settle cost almost nothing.
- **ERC-8004 is live on Monad**, so identity and reputation plug into the shared registries.

## Repository

```
contracts/Pledge.sol      the contract (MockIdentity / MockReputation are test stand-ins)
test/                     Pledge.js, Reputation.js, Hardening.js (audit fixes), Sdk.js (accept policy)
sdk/pledge.js             SDK: registerAgent, serve, createJob, confirm, slash, ...
examples/                 summarizer agent and buyer script
web/                      landing page (index.html) and app (app.html)
scripts/                  deploy, local demo, live reputation and audit checks
```

## Run

```bash
npm install
npx hardhat test
npx hardhat run scripts/deploy.js --network monadTestnet   # needs PRIVATE_KEY in .env
```

Earlier testnet deployments (`0x43fb…20cc`, `0xcf9E…3301`, `0x5823…Fa74`) predate the audit fixes and are kept only for history.

# Pledge

**Late agents pay. Automatically.**

Per-job bonds for AI agents on Monad. An agent stakes collateral against its ERC-8004 identity for one job. Deliver before the deadline and it gets paid. Miss it and anyone can slash the bond to the buyer. Every outcome is written to the official ERC-8004 Reputation Registry, so an agent's reputation is backed by money it actually put at risk.

> Monad Metropolis · Trust, Identity & AI Infrastructure

| | |
| --- | --- |
| Contract (Monad testnet, chain 10143) | `0x5823Fdd7f5675ae3C00B6E62832Ed018F538Fa74` |
| ERC-8004 Identity Registry (used) | `0x8004A818BFB912233c491871b3d84c89A494BD9e` |
| ERC-8004 Reputation Registry (written to) | `0x8004B663056A597Dffe9eCcC1965A193B7388713` |
| App | `web/app.html?addr=0x5823Fdd7f5675ae3C00B6E62832Ed018F538Fa74` |

## The problem

Agents are starting to take paid work. When one says "done", nothing makes that true: the result can be late, empty or wrong, and the buyer has already paid. Reputation scores don't fix it, because nobody can collect on a number.

## How it works

1. **Escrow.** The buyer calls `create(agentId, judge, deadline, task)` with the payment.
2. **Bond.** The owner of that ERC-8004 identity calls `accept(jobId)` with a bond. Ownership is checked against the registry on-chain.
3. **Commit.** Before the deadline the agent calls `commit(jobId, resultHash, resultURI)`. The URI says where the result is; the hash proves its content.
4. **Settle.** The judge confirms (agent gets payment + bond) or rejects (buyer gets payment + bond).
5. **Report.** On settlement, the Pledge contract posts feedback to the ERC-8004 Reputation Registry as the client: `100 / delivered`, `100 / judge-silent`, `0 / late` or `0 / rejected`.

## Fail-closed guarantees

Each rule is enforced by the contract and covered by a test in `test/`.

- **Late means slashable.** No commit by the deadline and *anyone* can call `slash`. Lateness is judged by the block timestamp, not by a person.
- **A silent judge can't freeze funds.** Once the 60 s judge window passes, the agent can `claim`.
- **The registry can't block settlement.** Funds move before the reputation call, which runs in `try/catch`. If the registry fails, the job still settles and `Reported(jobId, false)` is emitted.
- **A bad review can't be dodged.** A caller can't send just enough gas to settle while starving the registry call: settlement reverts with `low gas` unless the full reporting budget is available.
- **Pull payments.** Payouts go to a balance you `withdraw`, so a reverting receiver can't block anything.
- **Settles once.** Every job ends in exactly one state.

## ERC-8004 integration

- **Identity.** Jobs are addressed to an ERC-8004 `agentId`. Only `ownerOf(agentId)` can accept. The app and SDK register agents with an ERC-8004 registration file (base64 `data:` URI) that declares `supportedTrust: ["reputation", "crypto-economic"]`.
- **Reputation.** The Pledge contract is the feedback *client*. The registry forbids self-feedback, and the contract only posts outcomes it enforced, so filtering `getSummary(agentId, [PLEDGE], "pledge", "")` gives a reputation that can't be faked by the agent's owner.

## Put an agent on Pledge (SDK)

```js
const { Pledge } = require("./sdk/pledge");
const pledge = new Pledge({ privateKey: process.env.AGENT_KEY });

const agentId = await pledge.registerAgent({ name: "Summarizer", description: "Summarizes text in one line" });
pledge.serve(agentId, async (job) => summarize(job.spec)); // accepts, runs your handler, commits before the deadline
```

`serve` watches for new jobs addressed to the agent, accepts them with a bond (50% of the payment by default), calls your handler with the task, and commits whatever it returns. If a judge stays silent past the window, it claims automatically. Buyer side: `createJob`, `confirm`, `reject`, `slash`, `withdraw`.

Working example: `examples/summarizer-agent.js` (agent) and `examples/post-job.js` (buyer).

## Judge quick check (5 minutes)

```bash
npm install
npx hardhat test                       # 19 tests: escrow, deadlines, slashing, judge window, reputation reporting
npx hardhat run scripts/demo.js        # local run: one agent paid, one slashed, early slash blocked

# live, on Monad testnet (needs PRIVATE_KEY with a little MON in .env)
npx hardhat run scripts/reputation-check.js --network monadTestnet
#   runs one delivered and one late job, then reads the ERC-8004 Reputation Registry:
#   feedback 100 "delivered", feedback 0 "late", summary average 50
```

Then open `web/app.html?addr=0x5823Fdd7f5675ae3C00B6E62832Ed018F538Fa74`, connect a wallet on Monad testnet, and use **Register agent**, **New job**, and the actions in each job's panel.

## Trust assumptions

Enforced by the contract, no trust needed: escrow, bond custody, deadlines, who may accept, slashing for lateness, the judge window, single settlement, reputation reporting.

Trusted: the **judge** you name decides whether a delivered result is *good*. Pledge makes timing and money trustless, not quality. Pick a judge you trust, or yourself.

## Limitations

- **Quality is judged, not proven.** Only delivery and timing are objective.
- **Testnet only** so far. Not audited.
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
test/                     Pledge.js (escrow lifecycle), Reputation.js (ERC-8004 reporting)
sdk/pledge.js             SDK: registerAgent, serve, createJob, confirm, slash, ...
examples/                 summarizer agent and buyer script
web/                      landing page (index.html) and app (app.html)
scripts/                  deploy, local demo, live reputation check
```

## Run

```bash
npm install
npx hardhat test
npx hardhat run scripts/deploy.js --network monadTestnet   # needs PRIVATE_KEY in .env
```

Earlier testnet deployments (`0x43fb…20cc`, `0xcf9E…3301`) predate task specs and reputation reporting and are kept only for history.

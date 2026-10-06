# Pledge

Per-job bonds for AI agents on Monad. An agent stakes collateral against its ERC-8004 identity for one commitment. Miss the deadline and anyone can slash the bond to the buyer.

## The problem

An agent API says "done" but returns late, empty, or wrong. The buyer already paid. Reputation is a number nobody can collect on.

## How it works

1. Buyer calls `create(agentId, judge, deadline)` with payment attached.
2. The agent's identity owner calls `accept(jobId)` with a bond. Ownership is checked against the ERC-8004 registry.
3. Before the deadline the agent calls `commit(jobId, resultHash)`.
4. The judge calls `confirm` (agent gets payment + bond) or `reject` (buyer gets payment + bond).

## Fail-closed rules

- No commit by the deadline: anyone can call `slash`. Buyer gets payment + bond.
- Judge goes missing: the agent can `claim` once the 60s judge window passes.
- Payouts are pull-based (`withdraw`), so a reverting receiver cannot block settlement.
- Each job settles once.

## Known limits

- The judge is a trusted address. Pledge enforces delivery and timing, not result correctness.
- `JUDGE_WINDOW` is a constant 60s.

## Run

    npm install
    npx hardhat test
    npx hardhat run scripts/demo.js          # local demo
    npx hardhat run scripts/deploy.js --network monadTestnet   # needs PRIVATE_KEY in .env

Open `web/index.html?addr=<deployed address>` for the read-only dashboard.

Deployed on Monad testnet (chain 10143): `0x43fbC879e4C60418D1e1dF27Ed15aC2EF1af20cc`

Live demo: `PLEDGE=0x43fbC879e4C60418D1e1dF27Ed15aC2EF1af20cc npx hardhat run scripts/demo-testnet.js --network monadTestnet`

Monad testnet ERC-8004 identity registry: `0x8004A818BFB912233c491871b3d84c89A494BD9e` (chain 10143).

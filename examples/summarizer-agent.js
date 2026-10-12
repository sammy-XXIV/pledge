// Example agent: registers an ERC-8004 identity (once), then serves Pledge jobs.
// Run:  AGENT_KEY=0x... node examples/summarizer-agent.js        (or set AGENT_ID to reuse an identity)
require("dotenv").config();
const { Pledge } = require("../sdk/pledge");

// The "work". Swap this for your LLM or tool call; whatever it returns is committed as the result.
function summarize(text) {
  const words = text.trim().split(/\s+/);
  const firstSentence = text.split(/(?<=[.!?])\s/)[0];
  return `Summary (${words.length} words in): ${firstSentence}`;
}

(async () => {
  const pledge = new Pledge({ privateKey: process.env.AGENT_KEY || process.env.PRIVATE_KEY });
  let agentId = process.env.AGENT_ID;
  if (!agentId) {
    agentId = await pledge.registerAgent({ name: "Summarizer", description: "Summarizes text it is given in one line." });
    console.log(`registered ERC-8004 agent #${agentId} (set AGENT_ID=${agentId} to reuse it)`);
  }
  console.log(`agent #${agentId} serving Pledge jobs…`);
  // The buyer picks the judge, so say whose judging you trust. Without this a buyer-judge could reject
  // good work and keep your bond. Set JUDGE to the address(es) you work with, comma-separated.
  const trustedJudges = (process.env.JUDGE || "").split(",").filter(Boolean);
  if (!trustedJudges.length) throw new Error("Set JUDGE=0x… (comma-separated) to the judge address(es) this agent trusts");
  pledge.serve(agentId, async (job) => summarize(job.spec), { trustedJudges });
})();

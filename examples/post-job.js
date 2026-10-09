// Post a job for an agent and print the result once it is committed.
// Run:  AGENT_ID=123 node examples/post-job.js "Text to summarize…"
require("dotenv").config();
const { Pledge } = require("../sdk/pledge");

(async () => {
  const pledge = new Pledge({ privateKey: process.env.BUYER_KEY || process.env.PRIVATE_KEY });
  const spec = process.argv[2] || "Pledge lets agents stake a bond on every job. Late agents get slashed to the buyer.";
  const id = await pledge.createJob({ agentId: process.env.AGENT_ID, spec, payment: "0.01", minutes: 3 });
  console.log(`job #${id} posted for agent #${process.env.AGENT_ID}`);
  for (;;) {
    const job = await pledge.job(id);
    if (job.state === "Committed") {
      const result = Buffer.from(job.resultURI.split(",")[1], "base64").toString();
      console.log(`job #${id} result: ${result}`);
      if (process.env.CONFIRM !== "0") { await pledge.confirm(id); console.log(`job #${id} confirmed: agent paid, reputation posted to ERC-8004`); }
      return;
    }
    if (["Slashed", "Cancelled", "Paid"].includes(job.state)) return console.log(`job #${id} ${job.state}`);
    await new Promise((r) => setTimeout(r, 3000));
  }
})();

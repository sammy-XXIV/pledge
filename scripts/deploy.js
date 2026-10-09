// Deploys Pledge against the real ERC-8004 registries on Monad testnet.
const { ethers } = require("hardhat");
const IDENTITY = process.env.IDENTITY || "0x8004A818BFB912233c491871b3d84c89A494BD9e";
const REPUTATION = process.env.REPUTATION || "0x8004B663056A597Dffe9eCcC1965A193B7388713";

async function main() {
  const p = await (await ethers.getContractFactory("Pledge")).deploy(IDENTITY, REPUTATION);
  await p.waitForDeployment();
  console.log("Pledge:", await p.getAddress(), "identity:", IDENTITY, "reputation:", REPUTATION);
}
main().catch((e) => { console.error(e); process.exit(1); });

// Deploys Pledge against the real ERC-8004 identity registry on Monad testnet.
const { ethers } = require("hardhat");
const REGISTRY = process.env.IDENTITY || "0x8004A818BFB912233c491871b3d84c89A494BD9e";

async function main() {
  const p = await (await ethers.getContractFactory("Pledge")).deploy(REGISTRY);
  await p.waitForDeployment();
  console.log("Pledge:", await p.getAddress(), "registry:", REGISTRY);
}
main().catch((e) => { console.error(e); process.exit(1); });

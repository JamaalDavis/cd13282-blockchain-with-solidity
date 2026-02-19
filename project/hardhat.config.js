require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config();

// Load secrets from .env — never commit the real .env file to version control
const SEPOLIA_RPC_URL = process.env.SEPOLIA_RPC_URL || "";
const PRIVATE_KEY     = process.env.PRIVATE_KEY     || "";

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: "0.8.28",
  networks: {
    // Local Hardhat network (default — used automatically by `hardhat test`)
    hardhat: {},

    // Sepolia testnet — deploy with:
    //   npx hardhat run scripts/deploy.js --network sepolia
    sepolia: {
      url:      SEPOLIA_RPC_URL,
      accounts: PRIVATE_KEY ? [`0x${PRIVATE_KEY}`] : [],
    },
  },
};

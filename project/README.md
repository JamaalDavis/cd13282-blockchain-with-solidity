# CollateralizedLoan

A peer-to-peer collateralized lending protocol on Ethereum, built with Solidity and Hardhat.

## Sepolia Testnet Deployment

| Contract | Address | Etherscan |
|---|---|---|
| CollateralizedLoan | `0x6A1bd71aE620aEAB338aEe1502B60235580741C8` | [View on Etherscan](https://sepolia.etherscan.io/address/0x6A1bd71aE620aEAB338aEe1502B60235580741C8) |
| MockToken (ERC20) | `0x39b9dE97aAF1fFd11045056D195CA8D6f3aEd900` | [View on Etherscan](https://sepolia.etherscan.io/address/0x39b9dE97aAF1fFd11045056D195CA8D6f3aEd900) |

## Setup

```bash
npm install
cp .env.example .env
# Fill in SEPOLIA_RPC_URL and PRIVATE_KEY in .env
```

## Commands

```bash
npm test                                                    # run tests on local Hardhat network
npx hardhat run scripts/deploy.js --network sepolia        # deploy to Sepolia
```

const { ethers } = require("hardhat");

async function main() {
    const [deployer] = await ethers.getSigners();

    console.log("Deploying contracts with the account:", deployer.address);

    // Deploy MockToken for local testing.
    // On a live testnet/mainnet, use an existing ERC20 token address instead.
    const MockToken = await ethers.getContractFactory("MockToken");
    const mockToken = await MockToken.deploy();
    await mockToken.waitForDeployment();
    const mockTokenAddress = await mockToken.getAddress();

    console.log("MockToken deployed to:", mockTokenAddress);

    const CollateralizedLoan = await ethers.getContractFactory("CollateralizedLoan");
    const collateralizedLoan = await CollateralizedLoan.deploy(mockTokenAddress);
    await collateralizedLoan.waitForDeployment();

    console.log("CollateralizedLoan deployed to:", await collateralizedLoan.getAddress());
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });

const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("CollateralizedLoan", function () {
    let CollateralizedLoan, collateralizedLoan;
    let MockToken, mockToken;
    let owner, borrower, lender;

    // Common loan parameters reused across tests
    const COLLATERAL   = ethers.parseEther("1");    // 1 ETH collateral
    const PRINCIPAL    = ethers.parseEther("100");  // 100 MCK principal
    const INTEREST     = ethers.parseEther("10");   // 10 MCK interest
    const DURATION     = 3600;                      // 1 hour in seconds

    beforeEach(async function () {
        [owner, borrower, lender] = await ethers.getSigners();

        // Deploy a fresh MockToken (ERC20) for each test
        MockToken = await ethers.getContractFactory("MockToken");
        mockToken = await MockToken.deploy();

        // Deploy CollateralizedLoan pointing at the mock token
        CollateralizedLoan = await ethers.getContractFactory("CollateralizedLoan");
        collateralizedLoan = await CollateralizedLoan.deploy(await mockToken.getAddress());

        // Pre-fund the lender with enough tokens to cover the principal
        await mockToken.mint(lender.address, ethers.parseEther("1000"));
    });

    // =========================================================================
    // Loan request (deposit)
    // =========================================================================

    it("Should allow a borrower to deposit collateral and request a loan", async function () {
        await expect(
            collateralizedLoan.connect(borrower).depositCollateralAndRequestLoan(
                PRINCIPAL, INTEREST, DURATION,
                { value: COLLATERAL }
            )
        )
            .to.emit(collateralizedLoan, "LoanRequested")
            .withArgs(0, borrower.address, PRINCIPAL, INTEREST, DURATION);

        const loan = await collateralizedLoan.loans(0);
        expect(loan.borrower).to.equal(borrower.address);
        expect(loan.collateralAmount).to.equal(COLLATERAL);
        expect(loan.principal).to.equal(PRINCIPAL);
        expect(loan.interest).to.equal(INTEREST);
        expect(loan.isFunded).to.equal(false);
        expect(loan.dueDate).to.equal(0);   // not set until a lender funds the loan
    });

    // =========================================================================
    // Loan funding
    // =========================================================================

    it("Should allow a lender to fund a loan and set the due date from funding time", async function () {
        await collateralizedLoan.connect(borrower).depositCollateralAndRequestLoan(
            PRINCIPAL, INTEREST, DURATION, { value: COLLATERAL }
        );

        await mockToken.connect(lender).approve(await collateralizedLoan.getAddress(), PRINCIPAL);

        await expect(collateralizedLoan.connect(lender).fundLoan(0))
            .to.emit(collateralizedLoan, "LoanFunded")
            .withArgs(0, lender.address);

        const loan = await collateralizedLoan.loans(0);
        expect(loan.isFunded).to.equal(true);
        expect(loan.lender).to.equal(lender.address);
        // Due date must be set (non-zero) and in the future
        expect(loan.dueDate).to.be.gt(0);

        // Borrower should have received the principal
        expect(await mockToken.balanceOf(borrower.address)).to.equal(PRINCIPAL);
    });

    // =========================================================================
    // Full repayment
    // =========================================================================

    it("Should allow the borrower to repay the loan in full and recover collateral", async function () {
        await collateralizedLoan.connect(borrower).depositCollateralAndRequestLoan(
            PRINCIPAL, INTEREST, DURATION, { value: COLLATERAL }
        );

        await mockToken.connect(lender).approve(await collateralizedLoan.getAddress(), PRINCIPAL);
        await collateralizedLoan.connect(lender).fundLoan(0);

        // Borrower received the principal; also needs the interest tokens to repay
        await mockToken.mint(borrower.address, INTEREST);

        const repaymentAmount = PRINCIPAL + INTEREST;
        await mockToken.connect(borrower).approve(await collateralizedLoan.getAddress(), repaymentAmount);

        await expect(collateralizedLoan.connect(borrower).repayLoan(0))
            .to.emit(collateralizedLoan, "LoanRepaid")
            .withArgs(0, borrower.address);

        const loan = await collateralizedLoan.loans(0);
        expect(loan.isRepaid).to.equal(true);

        // Lender should have received the full repayment
        expect(await mockToken.balanceOf(lender.address)).to.equal(
            ethers.parseEther("1000") - PRINCIPAL + repaymentAmount
        );
    });

    it("Should reject repayment from an address that is not the borrower", async function () {
        await collateralizedLoan.connect(borrower).depositCollateralAndRequestLoan(
            PRINCIPAL, INTEREST, DURATION, { value: COLLATERAL }
        );

        await mockToken.connect(lender).approve(await collateralizedLoan.getAddress(), PRINCIPAL);
        await collateralizedLoan.connect(lender).fundLoan(0);

        // Give owner (a third party) the tokens to attempt repayment
        const repaymentAmount = PRINCIPAL + INTEREST;
        await mockToken.mint(owner.address, repaymentAmount);
        await mockToken.connect(owner).approve(await collateralizedLoan.getAddress(), repaymentAmount);

        await expect(
            collateralizedLoan.connect(owner).repayLoan(0)
        ).to.be.revertedWith("Only borrower can repay");
    });

    // =========================================================================
    // Early repayment with rebate
    // =========================================================================

    it("Should give the borrower a proportional rebate on early repayment", async function () {
        await collateralizedLoan.connect(borrower).depositCollateralAndRequestLoan(
            PRINCIPAL, INTEREST, DURATION, { value: COLLATERAL }
        );

        await mockToken.connect(lender).approve(await collateralizedLoan.getAddress(), PRINCIPAL);
        await collateralizedLoan.connect(lender).fundLoan(0);

        // Advance time to the halfway point of the loan
        const halfDuration = DURATION / 2;
        await ethers.provider.send("evm_increaseTime", [halfDuration]);
        await ethers.provider.send("evm_mine");

        // At the halfway mark: timeRemaining ≈ halfDuration
        // rebate ≈ interest × halfDuration / DURATION = interest / 2
        // reducedRepayment ≈ principal + interest / 2

        // Borrower needs to cover the reduced repayment (principal + partial interest)
        await mockToken.mint(borrower.address, INTEREST); // provide full interest as buffer
        const repaymentAmount = PRINCIPAL + INTEREST;
        await mockToken.connect(borrower).approve(await collateralizedLoan.getAddress(), repaymentAmount);

        const lenderBalanceBefore = await mockToken.balanceOf(lender.address);

        const tx = await collateralizedLoan.connect(borrower).earlyRepayLoan(0);
        const receipt = await tx.wait();

        // Confirm the LoanEarlyRepaid event was emitted with a non-zero rebate
        const event = receipt.logs
            .map(log => { try { return collateralizedLoan.interface.parseLog(log); } catch { return null; } })
            .find(e => e && e.name === "LoanEarlyRepaid");

        expect(event).to.not.be.undefined;
        expect(event.args.rebateAmount).to.be.gt(0);

        const updatedLoan = await collateralizedLoan.loans(0);
        expect(updatedLoan.isRepaid).to.equal(true);

        // Lender should have received less than the full repaymentAmount (rebate applied)
        const lenderBalanceAfter = await mockToken.balanceOf(lender.address);
        expect(lenderBalanceAfter - lenderBalanceBefore).to.be.lt(PRINCIPAL + INTEREST);
        expect(lenderBalanceAfter - lenderBalanceBefore).to.be.gt(PRINCIPAL); // still got principal back
    });

    it("Should reject early repayment after the due date has passed", async function () {
        await collateralizedLoan.connect(borrower).depositCollateralAndRequestLoan(
            PRINCIPAL, INTEREST, DURATION, { value: COLLATERAL }
        );

        await mockToken.connect(lender).approve(await collateralizedLoan.getAddress(), PRINCIPAL);
        await collateralizedLoan.connect(lender).fundLoan(0);

        // Skip past the due date
        await ethers.provider.send("evm_increaseTime", [DURATION + 1]);
        await ethers.provider.send("evm_mine");

        await mockToken.mint(borrower.address, INTEREST);
        await mockToken.connect(borrower).approve(
            await collateralizedLoan.getAddress(), PRINCIPAL + INTEREST
        );

        await expect(
            collateralizedLoan.connect(borrower).earlyRepayLoan(0)
        ).to.be.revertedWith("Loan is past due; use repayLoan");
    });

    // =========================================================================
    // Collateral claim on default
    // =========================================================================

    it("Should allow the lender to claim collateral after a default", async function () {
        await collateralizedLoan.connect(borrower).depositCollateralAndRequestLoan(
            PRINCIPAL, INTEREST, DURATION, { value: COLLATERAL }
        );

        await mockToken.connect(lender).approve(await collateralizedLoan.getAddress(), PRINCIPAL);
        await collateralizedLoan.connect(lender).fundLoan(0);

        // Skip past the due date
        await ethers.provider.send("evm_increaseTime", [DURATION + 1]);
        await ethers.provider.send("evm_mine");

        const lenderEthBefore = await ethers.provider.getBalance(lender.address);

        await expect(collateralizedLoan.connect(lender).claimCollateral(0))
            .to.emit(collateralizedLoan, "CollateralClaimed")
            .withArgs(0, lender.address);

        const updatedLoan = await collateralizedLoan.loans(0);
        expect(updatedLoan.isRepaid).to.equal(true);

        // Lender should have received the ETH collateral (minus gas)
        const lenderEthAfter = await ethers.provider.getBalance(lender.address);
        expect(lenderEthAfter).to.be.gt(lenderEthBefore);
    });

    // =========================================================================
    // Loan cancellation
    // =========================================================================

    it("Should allow the borrower to cancel an unfunded loan and recover collateral", async function () {
        await collateralizedLoan.connect(borrower).depositCollateralAndRequestLoan(
            PRINCIPAL, INTEREST, DURATION, { value: COLLATERAL }
        );

        const borrowerEthBefore = await ethers.provider.getBalance(borrower.address);

        await expect(collateralizedLoan.connect(borrower).cancelLoan(0))
            .to.emit(collateralizedLoan, "LoanCancelled")
            .withArgs(0, borrower.address);

        const loan = await collateralizedLoan.loans(0);
        expect(loan.isCancelled).to.equal(true);

        // Collateral refunded — borrower balance should be higher (minus gas)
        const borrowerEthAfter = await ethers.provider.getBalance(borrower.address);
        expect(borrowerEthAfter).to.be.gt(borrowerEthBefore);
    });

    it("Should prevent cancelling a loan that has already been funded", async function () {
        await collateralizedLoan.connect(borrower).depositCollateralAndRequestLoan(
            PRINCIPAL, INTEREST, DURATION, { value: COLLATERAL }
        );

        await mockToken.connect(lender).approve(await collateralizedLoan.getAddress(), PRINCIPAL);
        await collateralizedLoan.connect(lender).fundLoan(0);

        await expect(
            collateralizedLoan.connect(borrower).cancelLoan(0)
        ).to.be.revertedWith("Cannot cancel a funded loan");
    });

    it("Should prevent a lender from funding a cancelled loan", async function () {
        await collateralizedLoan.connect(borrower).depositCollateralAndRequestLoan(
            PRINCIPAL, INTEREST, DURATION, { value: COLLATERAL }
        );

        await collateralizedLoan.connect(borrower).cancelLoan(0);

        await mockToken.connect(lender).approve(await collateralizedLoan.getAddress(), PRINCIPAL);
        await expect(
            collateralizedLoan.connect(lender).fundLoan(0)
        ).to.be.revertedWith("Loan has been cancelled");
    });
});

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

// OpenZeppelin: standard ERC20 interface for interacting with the loan token
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
// OpenZeppelin: mutex guard that prevents a function from being called again
// while it is still executing (protects all ETH-transfer functions)
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title  CollateralizedLoan
/// @notice A peer-to-peer collateralized lending protocol on Ethereum.
///
///         Flow:
///         1. Borrower deposits ETH as collateral and specifies the ERC20 principal,
///            interest, and duration they want → `depositCollateralAndRequestLoan`.
///         2. A lender sees the open request and funds it by sending the principal
///            directly to the borrower → `fundLoan`. The repayment clock starts here.
///         3a. Borrower repays principal + full interest before or on the due date
///             → `repayLoan`. Collateral is returned.
///         3b. Borrower repays EARLY and earns a proportional interest rebate
///             → `earlyRepayLoan`. Lender receives less interest; borrower gets collateral back.
///         4. If the borrower fails to repay by the due date, the lender claims the
///            collateral as compensation → `claimCollateral`.
///         At any point before funding, the borrower can cancel and recover collateral
///         → `cancelLoan`.
contract CollateralizedLoan is ReentrancyGuard {

    // =========================================================================
    // Data Structures
    // =========================================================================

    /// @notice Full state of a single loan.
    struct Loan {
        address borrower;         // Who deposited collateral and requested the loan
        address lender;           // Who funded the loan (address(0) until funded)
        uint256 collateralAmount; // ETH held by this contract as security (in wei)
        uint256 principal;        // ERC20 token amount the borrower wants to borrow
        uint256 interest;         // ERC20 token interest agreed upfront by the borrower
        uint256 repaymentAmount;  // Cached value: principal + interest (full repayment)
        uint256 duration;         // Agreed loan length in seconds; stored so the due date
                                  //   can be set correctly at funding time (not request time)
        uint256 dueDate;          // Unix timestamp after which the lender may claim collateral
                                  //   (0 until the loan is funded)
        bool isFunded;            // True once a lender has sent the principal
        bool isRepaid;            // True once repaid OR collateral claimed (loan is closed)
        bool isCancelled;         // True if borrower cancelled before any lender funded
    }

    // =========================================================================
    // State Variables
    // =========================================================================

    /// @notice ERC20 token used for all loan principal and interest transfers.
    IERC20 public loanToken;

    /// @notice Counter used to assign a unique ID to every new loan request.
    ///         Starts at 0 and increments by 1 after each request.
    uint256 public nextLoanId;

    /// @notice Primary storage: maps a loan ID to its complete Loan data.
    mapping(uint256 => Loan) public loans;

    // =========================================================================
    // Events
    // =========================================================================

    /// @notice Emitted when a borrower opens a loan request.
    /// @param loanId   Unique identifier for the new loan.
    /// @param borrower Address of the borrower.
    /// @param amount   ERC20 principal amount requested.
    /// @param interest ERC20 interest the borrower agrees to pay.
    /// @param duration Repayment window in seconds (starts when funded).
    event LoanRequested(
        uint256 indexed loanId,
        address indexed borrower,
        uint256 amount,
        uint256 interest,
        uint256 duration
    );

    /// @notice Emitted when a lender funds a loan and principal is sent to the borrower.
    /// @param loanId Unique identifier of the funded loan.
    /// @param lender Address of the lender.
    event LoanFunded(uint256 indexed loanId, address indexed lender);

    /// @notice Emitted when the borrower repays the loan in full (on time or after due date).
    /// @param loanId   Unique identifier of the repaid loan.
    /// @param borrower Address of the borrower.
    event LoanRepaid(uint256 indexed loanId, address indexed borrower);

    /// @notice Emitted when the borrower repays early and qualifies for a rebate.
    /// @param loanId       Unique identifier of the loan.
    /// @param borrower     Address of the borrower.
    /// @param rebateAmount ERC20 interest amount that was forgiven (not paid to lender).
    event LoanEarlyRepaid(
        uint256 indexed loanId,
        address indexed borrower,
        uint256 rebateAmount
    );

    /// @notice Emitted when the lender claims the collateral after a borrower default.
    /// @param loanId Unique identifier of the defaulted loan.
    /// @param lender Address of the lender who claimed the collateral.
    event CollateralClaimed(uint256 indexed loanId, address indexed lender);

    /// @notice Emitted when the borrower cancels an unfunded loan and recovers collateral.
    /// @param loanId   Unique identifier of the cancelled loan.
    /// @param borrower Address of the borrower.
    event LoanCancelled(uint256 indexed loanId, address indexed borrower);

    // =========================================================================
    // Constructor
    // =========================================================================

    /// @param _loanToken Address of the ERC20 token contract used for lending.
    constructor(address _loanToken) {
        loanToken = IERC20(_loanToken);
    }

    // =========================================================================
    // Internal Helpers
    // =========================================================================

    /// @dev Return a storage pointer to the loan and revert if it does not exist.
    function _getLoan(uint256 loanId) internal view returns (Loan storage loan) {
        loan = loans[loanId];
        require(loan.borrower != address(0), "Loan does not exist");
    }

    /// @dev Revert unless the loan has been funded and is not yet closed.
    function _requireActive(Loan storage loan) internal view {
        require(loan.isFunded,  "Loan not funded");
        require(!loan.isRepaid, "Loan already repaid");
    }

    // =========================================================================
    // Borrower Functions
    // =========================================================================

    /// @notice Step 1 — Deposit ETH as collateral and open a loan request.
    ///
    /// @dev The ETH sent with this call (`msg.value`) is locked in this contract
    ///      until repayment, default, or cancellation.
    ///      `dueDate` is intentionally left as 0 here and set in `fundLoan` so the
    ///      repayment window always starts from the moment of actual funding.
    ///
    /// @param amount    ERC20 principal the borrower wants to receive.
    /// @param interest  ERC20 interest the borrower commits to pay on top of the principal.
    /// @param duration  Repayment window in seconds, beginning when a lender funds the loan.
    function depositCollateralAndRequestLoan(
        uint256 amount,
        uint256 interest,
        uint256 duration
    ) external payable {
        require(msg.value > 0, "Collateral must be greater than 0");
        require(amount > 0, "Loan amount must be greater than 0");
        require(duration > 0, "Duration must be greater than 0");

        // Pre-compute full repayment amount to save gas on every repayment call
        uint256 repaymentAmount = amount + interest;

        loans[nextLoanId] = Loan({
            borrower: msg.sender,
            collateralAmount: msg.value,
            principal: amount,
            interest: interest,
            repaymentAmount: repaymentAmount,
            duration: duration,
            dueDate: 0,           // set when funded
            lender: address(0),
            isFunded: false,
            isRepaid: false,
            isCancelled: false
        });

        emit LoanRequested(nextLoanId, msg.sender, amount, interest, duration);
        nextLoanId++;
    }

    /// @notice Repay the loan in full (principal + full interest) and reclaim collateral.
    ///
    /// @dev The borrower must have approved this contract to spend at least
    ///      `loan.repaymentAmount` tokens before calling this function.
    ///      For an early-repayment discount, use `earlyRepayLoan` instead.
    ///
    /// @param loanId The ID of the funded loan to repay.
    function repayLoan(uint256 loanId) external nonReentrant {
        Loan storage loan = _getLoan(loanId);
        _requireActive(loan);
        require(msg.sender == loan.borrower, "Only borrower can repay");

        loan.isRepaid = true;

        // Transfer full repayment (principal + interest) from borrower to lender
        require(
            loanToken.transferFrom(msg.sender, loan.lender, loan.repaymentAmount),
            "Token transfer failed"
        );

        // Return the locked collateral ETH to the borrower
        (bool success, ) = loan.borrower.call{value: loan.collateralAmount}("");
        require(success, "Collateral transfer failed");

        emit LoanRepaid(loanId, loan.borrower);
    }

    /// @notice Repay early and receive a proportional rebate on the interest owed.
    ///
    /// @dev Rebate formula:
    ///         rebate = interest × timeRemaining / duration
    ///      The borrower only pays (repaymentAmount − rebate).
    ///      Example: 50 % of duration remaining → 50 % interest rebate.
    ///
    ///      The borrower must have approved this contract to spend at least
    ///      (repaymentAmount − rebate) tokens. Since the exact rebate depends on
    ///      the block timestamp, approving the full `repaymentAmount` is the safe
    ///      upper bound.
    ///
    /// @param loanId The ID of the funded loan to repay early.
    function earlyRepayLoan(uint256 loanId) external nonReentrant {
        Loan storage loan = _getLoan(loanId);
        _requireActive(loan);
        require(msg.sender == loan.borrower, "Only borrower can repay");
        require(block.timestamp < loan.dueDate, "Loan is past due; use repayLoan");

        // How much time is left in the repayment window?
        uint256 timeRemaining = loan.dueDate - block.timestamp;

        // Rebate is proportional to the fraction of duration that remains unused
        uint256 rebate = (loan.interest * timeRemaining) / loan.duration;

        // Borrower pays less; lender still receives principal + partial interest
        uint256 reducedRepayment = loan.repaymentAmount - rebate;

        loan.isRepaid = true;

        // Transfer the reduced repayment from borrower to lender
        require(
            loanToken.transferFrom(msg.sender, loan.lender, reducedRepayment),
            "Token transfer failed"
        );

        // Return the locked collateral ETH to the borrower
        (bool success, ) = loan.borrower.call{value: loan.collateralAmount}("");
        require(success, "Collateral transfer failed");

        emit LoanEarlyRepaid(loanId, loan.borrower, rebate);
    }

    /// @notice Cancel an unfunded loan request and recover the deposited collateral.
    ///
    /// @dev Only callable by the borrower, and only while the loan has not yet been funded.
    ///      Prevents a lender from funding a cancelled loan by setting `isCancelled = true`.
    ///
    /// @param loanId The ID of the open loan request to cancel.
    function cancelLoan(uint256 loanId) external nonReentrant {
        Loan storage loan = _getLoan(loanId);
        require(msg.sender == loan.borrower, "Only borrower can cancel");
        require(!loan.isFunded, "Cannot cancel a funded loan");
        require(!loan.isCancelled, "Loan already cancelled");

        loan.isCancelled = true;

        // Refund the collateral ETH to the borrower
        (bool success, ) = loan.borrower.call{value: loan.collateralAmount}("");
        require(success, "Collateral refund failed");

        emit LoanCancelled(loanId, loan.borrower);
    }

    // =========================================================================
    // Lender Functions
    // =========================================================================

    /// @notice Step 2 — Fund an open loan request by sending the principal to the borrower.
    ///
    /// @dev Sets `dueDate = block.timestamp + loan.duration` so the repayment window
    ///      always begins at actual funding time, not the earlier request time.
    ///      The lender must have approved this contract to spend at least `loan.principal`
    ///      tokens before calling this function.
    ///
    /// @param loanId The ID of the loan request to fund.
    function fundLoan(uint256 loanId) external nonReentrant {
        Loan storage loan = _getLoan(loanId);
        require(!loan.isFunded, "Loan already funded");
        require(!loan.isCancelled, "Loan has been cancelled");

        loan.lender = msg.sender;
        loan.isFunded = true;
        // Start the repayment clock from this exact moment
        loan.dueDate = block.timestamp + loan.duration;

        // Transfer principal directly from lender to borrower
        require(
            loanToken.transferFrom(msg.sender, loan.borrower, loan.principal),
            "Token transfer failed"
        );

        emit LoanFunded(loanId, msg.sender);
    }

    /// @notice Claim the borrower's collateral as compensation after a loan default.
    ///
    /// @dev A default occurs when the due date has passed and the loan has not been repaid.
    ///      Only the lender of that specific loan may call this function.
    ///      `isRepaid` is reused as a general "loan closed" flag to block double-claims.
    ///
    /// @param loanId The ID of the defaulted loan.
    function claimCollateral(uint256 loanId) external nonReentrant {
        Loan storage loan = _getLoan(loanId);
        _requireActive(loan);
        require(block.timestamp > loan.dueDate, "Loan not yet due");
        require(msg.sender == loan.lender, "Only lender can claim");

        // Mark loan as closed before transferring to prevent reentrancy
        loan.isRepaid = true;

        // Transfer the locked collateral ETH to the lender
        (bool success, ) = loan.lender.call{value: loan.collateralAmount}("");
        require(success, "Collateral transfer failed");

        emit CollateralClaimed(loanId, loan.lender);
    }
}

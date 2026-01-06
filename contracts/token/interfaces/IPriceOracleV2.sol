// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @notice Canonical quote for GSTEP/ETH with freshness + confidence.
interface IPriceOracleV2 {
    error StalePrice(uint256 updatedAt, uint256 nowTs, uint256 maxStaleness);
    error InvalidPrice();
    error ConfidenceTooLow(uint256 confidenceBps, uint256 minConfidenceBps);

    /// @return priceWei      Price of 1 GSTEP in wei (1e18).
    /// @return updatedAt     Unix timestamp (sec).
    /// @return confidenceBps ±band in basis points; 0 if not provided.
    function latestTokenPriceWei()
        external
        view
        returns (uint256 priceWei, uint256 updatedAt, uint256 confidenceBps);

    function maxStaleness() external view returns (uint256);
    function minConfidenceBps() external view returns (uint256);

    /// @dev Reverts if stale/invalid/low-confidence per policy.
    function quoteTokenInWei(uint256 gstAmount) external view returns (uint256);
}

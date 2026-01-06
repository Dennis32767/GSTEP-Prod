// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import "../token/interfaces/IPriceOracleV2.sol";

contract MockOracleV2 is IPriceOracleV2 {
    uint256 public priceWei = 1e16; // 0.01 ETH
    uint256 public updatedAt = 1e9;
    uint256 public confidenceBps = 0;
    uint256 public stale = 300;
    uint256 public minConf = 100;

    function set(uint256 p, uint256 t, uint256 c) external { priceWei=p; updatedAt=t; confidenceBps=c; }
    function setPolicy(uint256 s, uint256 m) external { stale=s; minConf=m; }

    function latestTokenPriceWei() external view returns (uint256, uint256, uint256) {
        return (priceWei, updatedAt, confidenceBps);
    }
    function maxStaleness() external view returns (uint256) { return stale; }
    function minConfidenceBps() external view returns (uint256) { return minConf; }

    function quoteTokenInWei(uint256 gstAmount) external view returns (uint256) {
        if (block.timestamp - updatedAt > stale) revert StalePrice(updatedAt, block.timestamp, stale);
        if (priceWei == 0) revert InvalidPrice();
        if (confidenceBps != 0 && confidenceBps > minConf) revert ConfidenceTooLow(confidenceBps, minConf);
        unchecked { return (gstAmount * priceWei) / 1e18; }
    }
}

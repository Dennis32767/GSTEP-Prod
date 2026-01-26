// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import "../core/GemStepCore.sol";

/// @title GS_AnomalyAndFraud
/// @notice Fraud-prevention module for step submissions (NO SLASHING / NO PENALTIES).
/// @dev
///  UPDATED BEHAVIOR (per your latest rules):
///   - Stake asset is GSTEP (token units, 18 decimals).
///   - For NON-trusted callers (user-path):
///        1) Enforce min-interval + daily cap
///        2) Require stake >= steps * MIN_STAKE_PER_STEP  (MIN_STAKE_PER_STEP is GSTEP-per-step)
///        3) Allow only the first {anomalyThreshold} successful NON-API submissions per user
///           After that: revert "GS: trusted API caller/relayer required" (so no more minting without trusted API caller).
///   - Trusted API callers are exempt from onboarding cap and stake requirement.
///   - EMA tracking is retained (optional analytics), but NO penalties and NO slashing are applied.
abstract contract GS_AnomalyAndFraud is GemStepCore {
    /* =============================================================
                         HOOK: FRAUD PREVENTION (PRE)
       ============================================================= */

    /// @inheritdoc GemStepCore
    function _applyFraudPrevention(
        address user,
        uint256 steps,
        string calldata source
    ) internal view override {
        SourceConfig storage config = sourceConfigs[source];
        uint256 ts = block.timestamp;

        /* -------------------- Min interval per (user,source) -------------------- */
        require(ts >= lastSubmission[user][source] + config.minInterval, "Submission too frequent");

        /* ----------------------- Daily cap (UTC day index) ----------------------- */
        uint256 day = ts / 1 days;
        uint256 usedToday = (dailyIndex[user][source] == day) ? dailyStepTotal[user][source] : 0;
        require(usedToday + steps <= config.maxStepsPerDay, "Daily limit exceeded");

        /* ---------------- Onboarding + stake gate (NON-API callers) -------------- */
        // Trusted API callers are exempt (backend relayer / approved signer path).
        if (!isTrustedAPI[msg.sender]) {
            // After onboarding submissions are used up, only trusted API callers may submit/mint.
            require(nonApiSubmissionCount[user] < anomalyThreshold, "GS: trusted API caller/relayer required");

            // During onboarding, require minimum stake (token-denominated, 18 decimals).
            // IMPORTANT: MIN_STAKE_PER_STEP must be defined as GSTEP-per-step (not wei).
            uint256 requiredStake = steps * MIN_STAKE_PER_STEP;
            require(stakeBalance[user] >= requiredStake, "Insufficient stake");
        }
    }

    /* =============================================================
                       HOOK: RECORD (POST)
       ============================================================= */

    /// @inheritdoc GemStepCore
    /// @dev Records timing/daily totals; increments onboarding counter for non-API callers.
    ///      No penalties/slashing/suspension logic is applied in this revised version.
    function _recordSubmissionAndAnomaly(
        address user,
        uint256 steps,
        string calldata source
    ) internal override {
        uint256 ts = block.timestamp;

        /* ---------------- Record timing (min-interval anchor) ---------------- */
        lastSubmission[user][source] = ts;

        /* ---------------- Daily rollover + accumulate (cap anchor) ----------- */
        uint256 day = ts / 1 days;
        if (dailyIndex[user][source] != day) {
            dailyIndex[user][source] = day;
            dailyStepTotal[user][source] = 0;
        }
        unchecked {
            dailyStepTotal[user][source] += steps;
        }

        /* ---------------- First submission timestamp (grace anchor) ---------- */
        // Still useful for analytics/telemetry and for future logic if reintroduced.
        if (userFirstSubmission[user] == 0) {
            userFirstSubmission[user] = ts;
        }

        /* ---------------- Count onboarding submissions (NON-API only) -------- */
        if (!isTrustedAPI[msg.sender]) {
            unchecked {
                nonApiSubmissionCount[user] += 1;
            }
        }

        /* ---------------- Update EMA (optional analytics) -------------------- */
        // EMA-like update with 90% previous + 10% new; scaled by 100.
        uint256 prev = userStepAverage[user];
        userStepAverage[user] = (prev * 9 + steps * 100) / 10;
    }
}

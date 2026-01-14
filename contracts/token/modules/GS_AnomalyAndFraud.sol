// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import "../core/GemStepCore.sol";

/// @title GS_AnomalyAndFraud
/// @notice Anomaly detection and fraud-prevention module for step submissions.
/// @dev
///  - Implements GemStepCore hooks used by the step verification module:
///    - {_applyFraudPrevention}: pre-checks before accepting a submission
///    - {_recordSubmissionAndAnomaly}: records timing/daily totals and applies anomaly penalties
///  - Key mechanics:
///    - Per-(user,source) minimum submission interval
///    - Per-(user,source) daily step cap (UTC day index)
///    - Stake requirement for user-path submissions (non-trusted API callers)
///    - Anomaly detection against an EMA-like rolling average with a grace period
///    - Penalty slashing and suspension after repeated anomalies
///  - Trusted API callers are exempt from stake requirement and anomaly penalties,
///    but are still recorded for interval/daily tracking and EMA updates.
abstract contract GS_AnomalyAndFraud is GemStepCore {
    /* =============================================================
                         HOOK: FRAUD PREVENTION (PRE)
       ============================================================= */

    /// @inheritdoc GemStepCore
    /// @dev Enforces min-interval, daily cap, and (for non-API callers) stake requirement.
    function _applyFraudPrevention(
        address user,
        uint256 steps,
        string calldata source
    ) internal view override {
        SourceConfig storage config = sourceConfigs[source];
        uint256 ts = block.timestamp;

        /* -------------------- Min interval per (user,source) -------------------- */
        require(
            ts >= lastSubmission[user][source] + config.minInterval,
            "Submission too frequent"
        );

        /* ----------------------- Daily cap (UTC day index) ----------------------- */
        uint256 day = ts / 1 days;
        uint256 usedToday = (dailyIndex[user][source] == day)
            ? dailyStepTotal[user][source]
            : 0;

        require(usedToday + steps <= config.maxStepsPerDay, "Daily limit exceeded");

        /* ---------------- Stake requirement for user-path only ------------------ */
        // Trusted API callers are exempt (e.g., backend relayer).
        if (!isTrustedAPI[msg.sender]) {
            uint256 requiredStake = steps * currentStakePerStep;
            require(stakeBalance[user] >= requiredStake, "Insufficient stake");
        }
    }

    /* =============================================================
                       HOOK: RECORD + ANOMALY (POST)
       ============================================================= */

    /// @inheritdoc GemStepCore
    /// @dev Records timing/daily totals; applies anomaly penalty/suspension for non-API callers.
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
        uint256 first = userFirstSubmission[user];
        if (first == 0) {
            userFirstSubmission[user] = ts;
            first = ts;
        }

        /* ---------------- Anomaly penalties (NON-API callers only) ----------- */
        // Trusted API callers are exempt from penalties/suspension, but still
        // contribute to the user's EMA tracking below.
        if (!isTrustedAPI[msg.sender]) {
            uint256 avgScaled = userStepAverage[user]; // scaled by 100 (see EMA update below)

            // Only start anomaly checks after grace period and once average is meaningful.
            if (ts >= first + GRACE_PERIOD && avgScaled >= MIN_AVERAGE_FOR_ANOMALY) {
                // Trigger condition: steps is anomalyThreshold% above average (scaled math).
                // e.g. steps*100 > avgScaled*anomalyThreshold
                if (steps * 100 > avgScaled * anomalyThreshold) {
                    // Penalty based on stake-per-step and a percentage. Ensure dust floor = 1.
                    uint256 penalty = (steps * currentStakePerStep * PENALTY_PERCENT) / 100;
                    if (penalty == 0) penalty = 1;

                    // Apply up to available stake.
                    uint256 avail = stakeBalance[user];
                    uint256 applied = penalty <= avail ? penalty : avail;

                    if (applied > 0) {
                        stakeBalance[user] = avail - applied;
                        emit PenaltyApplied(user, applied);
                    }

                    // Track flags; suspend after 3.
                    uint256 flags = flaggedSubmissions[user] + 1;
                    flaggedSubmissions[user] = flags;

                    if (flags >= 3) {
                        uint256 untilTs = ts + SUSPENSION_DURATION;
                        suspendedUntil[user] = untilTs;
                        emit UserSuspended(user, untilTs);
                    }
                }
            }
        }

        /* ---------------- Update EMA after detection (for everyone) ----------- */
        // EMA-like update with 90% previous + 10% new; scaled by 100.
        uint256 prev = userStepAverage[user];
        userStepAverage[user] = (prev * 9 + steps * 100) / 10;
    }
}

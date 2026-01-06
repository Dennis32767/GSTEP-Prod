// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import "../core/GemStepCore.sol";

abstract contract GS_AnomalyAndFraud is GemStepCore {
    // Hook from GS_StepsAndVerification
    function _applyFraudPrevention(
        address user,
        uint256 steps,
        string calldata source
    ) internal view override {
        SourceConfig storage config = sourceConfigs[source];

        uint256 ts = block.timestamp;

        // Min-interval per (user, source)
        require(
            ts >= lastSubmission[user][source] + config.minInterval,
            "Submission too frequent"
        );

        // Daily cap (UTC day index)
        uint256 day = ts / 1 days;
        uint256 usedToday = (dailyIndex[user][source] == day) ? dailyStepTotal[user][source] : 0;
        require(usedToday + steps <= config.maxStepsPerDay, "Daily limit exceeded");

        // Stake requirement for user path only
        if (!isTrustedAPI[msg.sender]) {
            uint256 requiredStake = steps * currentStakePerStep;
            require(stakeBalance[user] >= requiredStake, "Insufficient stake");
        }
    }

    // Hook from GS_StepsAndVerification
    function _recordSubmissionAndAnomaly(
    address user,
    uint256 steps,
    string calldata source
) internal override {
    uint256 ts = block.timestamp;

    // Record timing (needed for min-interval enforcement next time)
    lastSubmission[user][source] = ts;

    // Daily rollover + accumulate (needed for daily-cap enforcement next time)
    uint256 day = ts / 1 days;
    if (dailyIndex[user][source] != day) {
        dailyIndex[user][source] = day;
        dailyStepTotal[user][source] = 0;
    }
    unchecked { dailyStepTotal[user][source] += steps; }

    // First submission timestamp (grace period anchor)
    uint256 first = userFirstSubmission[user];
    if (first == 0) {
        userFirstSubmission[user] = ts;
        first = ts;
    }

    // ✅ Only apply anomaly penalties/suspension for NON-API callers
    if (!isTrustedAPI[msg.sender]) {
        uint256 avgScaled = userStepAverage[user];
        if (ts >= first + GRACE_PERIOD && avgScaled >= MIN_AVERAGE_FOR_ANOMALY) {
            if (steps * 100 > avgScaled * anomalyThreshold) {
                uint256 penalty = (steps * currentStakePerStep * PENALTY_PERCENT) / 100;
                if (penalty == 0) penalty = 1;

                uint256 avail = stakeBalance[user];
                uint256 applied = penalty <= avail ? penalty : avail;
                if (applied > 0) {
                    stakeBalance[user] = avail - applied;
                    emit PenaltyApplied(user, applied);
                }

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

    // Update EMA after detection (we can still track it for everyone)
    uint256 prev = userStepAverage[user];
    userStepAverage[user] = (prev * 9 + steps * 100) / 10;
}
}

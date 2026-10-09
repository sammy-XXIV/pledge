// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// Test stand-in for the ERC-8004 Reputation Registry. Records the last feedback; can be told to revert.
contract MockReputation {
    struct Fb { address client; uint256 agentId; int128 value; uint8 decimals; string tag1; string tag2; bytes32 hash; }
    Fb public last;
    uint256 public count;
    bool public fail;

    function setFail(bool f) external { fail = f; }

    function giveFeedback(
        uint256 agentId, int128 value, uint8 valueDecimals, string calldata tag1, string calldata tag2,
        string calldata, string calldata, bytes32 feedbackHash
    ) external {
        require(!fail, "registry down");
        // burn gas like the real registry's first write (~296k measured on Monad testnet), so gas-floor tests are meaningful
        for (uint256 i = 0; i < 6; i++) assembly { sstore(add(0x1000, i), add(i, 1)) }
        last = Fb(msg.sender, agentId, value, valueDecimals, tag1, tag2, feedbackHash);
        count++;
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// Test stand-in for the ERC-8004 identity registry (an ERC-721).
contract MockIdentity {
    mapping(uint256 => address) public ownerOf;
    uint256 public next = 1;

    function register() external returns (uint256 id) {
        id = next++;
        ownerOf[id] = msg.sender;
    }
}

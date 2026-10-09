// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IIdentity {
    function ownerOf(uint256 agentId) external view returns (address);
}

interface IReputation {
    function giveFeedback(
        uint256 agentId, int128 value, uint8 valueDecimals, string calldata tag1, string calldata tag2,
        string calldata endpoint, string calldata feedbackURI, bytes32 feedbackHash
    ) external;
}

/// Per-job bond for AI agents, keyed to an ERC-8004 identity.
/// Buyer escrows payment. Agent stakes a bond and must commit a result hash
/// before the deadline, or anyone can slash it to the buyer. If the judge goes
/// missing after the deadline, the agent can claim. No party can freeze funds.
/// Every settlement is also posted to the ERC-8004 Reputation Registry, with this
/// contract as the client, so agent reputation reflects outcomes it enforced.
contract Pledge {
    enum State { None, Open, Active, Committed, Paid, Slashed, Cancelled }

    struct Job {
        address buyer;
        address judge;
        uint256 agentId;
        address agent;
        uint256 payment;
        uint256 bond;
        uint64 deadline;
        bytes32 resultHash;
        State state;
    }

    uint64 public constant JUDGE_WINDOW = 60;
    uint256 public constant REPORT_GAS = 400_000; // first giveFeedback measured at ~296k on Monad testnet

    IIdentity public immutable identity;
    IReputation public immutable reputation; // address(0) disables reporting
    Job[] public jobs;
    mapping(address => uint256) public credits; // pull payments: a reverting receiver can't block settlement
    mapping(uint256 => uint256) public completed; // agentId => jobs delivered
    mapping(uint256 => uint256) public slashed; // agentId => jobs failed
    mapping(uint256 => string) public specs; // jobId => task, written by the buyer
    mapping(uint256 => string) public resultURIs; // jobId => where the result lives; resultHash proves its content

    event Created(uint256 indexed jobId, address indexed buyer, uint256 indexed agentId, address judge, uint64 deadline, uint256 payment);
    event Accepted(uint256 indexed jobId, address agent, uint256 bond);
    event Committed(uint256 indexed jobId, bytes32 resultHash, string resultURI);
    event Paid(uint256 indexed jobId, uint256 indexed agentId);
    event Slashed(uint256 indexed jobId, uint256 indexed agentId);
    event Cancelled(uint256 indexed jobId);
    event Reported(uint256 indexed jobId, bool ok);

    constructor(address _identity, address _reputation) {
        identity = IIdentity(_identity);
        reputation = IReputation(_reputation);
    }

    function create(uint256 agentId, address judge, uint64 deadline, string calldata spec) external payable returns (uint256 jobId) {
        require(msg.value > 0, "no payment");
        require(deadline > block.timestamp, "bad deadline");
        jobId = jobs.length;
        jobs.push(Job(msg.sender, judge, agentId, address(0), msg.value, 0, deadline, 0, State.Open));
        specs[jobId] = spec;
        emit Created(jobId, msg.sender, agentId, judge, deadline, msg.value);
    }

    function accept(uint256 jobId) external payable {
        Job storage j = jobs[jobId];
        require(j.state == State.Open, "not open");
        require(block.timestamp < j.deadline, "too late");
        require(identity.ownerOf(j.agentId) == msg.sender, "not agent owner");
        require(msg.value > 0, "no bond");
        j.agent = msg.sender;
        j.bond = msg.value;
        j.state = State.Active;
        emit Accepted(jobId, msg.sender, msg.value);
    }

    function commit(uint256 jobId, bytes32 resultHash, string calldata resultURI) external {
        Job storage j = jobs[jobId];
        require(j.state == State.Active, "not active");
        require(msg.sender == j.agent, "not agent");
        require(block.timestamp <= j.deadline, "too late");
        j.resultHash = resultHash;
        j.state = State.Committed;
        resultURIs[jobId] = resultURI;
        emit Committed(jobId, resultHash, resultURI);
    }

    function confirm(uint256 jobId) external {
        Job storage j = _committedByJudge(jobId);
        _pay(jobId, j, "delivered");
    }

    function reject(uint256 jobId) external {
        Job storage j = _committedByJudge(jobId);
        _slash(jobId, j, "rejected");
    }

    /// Anyone can call once the deadline passes with no commit.
    function slash(uint256 jobId) external {
        Job storage j = jobs[jobId];
        require(j.state == State.Active, "not active");
        require(block.timestamp > j.deadline, "not late");
        _slash(jobId, j, "late");
    }

    /// Judge absent: agent collects after the judge window.
    function claim(uint256 jobId) external {
        Job storage j = jobs[jobId];
        require(j.state == State.Committed, "not committed");
        require(block.timestamp > j.deadline + JUDGE_WINDOW, "judge window open");
        _pay(jobId, j, "judge-silent");
    }

    function cancel(uint256 jobId) external {
        Job storage j = jobs[jobId];
        require(j.state == State.Open, "not open");
        require(msg.sender == j.buyer, "not buyer");
        j.state = State.Cancelled;
        credits[j.buyer] += j.payment;
        emit Cancelled(jobId);
    }

    function withdraw() external {
        uint256 amt = credits[msg.sender];
        require(amt > 0, "nothing");
        credits[msg.sender] = 0;
        (bool ok,) = msg.sender.call{value: amt}("");
        require(ok, "send failed");
    }

    function jobCount() external view returns (uint256) {
        return jobs.length;
    }

    function _committedByJudge(uint256 jobId) internal view returns (Job storage j) {
        j = jobs[jobId];
        require(j.state == State.Committed, "not committed");
        require(msg.sender == j.judge, "not judge");
    }

    function _pay(uint256 jobId, Job storage j, string memory tag) internal {
        j.state = State.Paid;
        credits[j.agent] += j.payment + j.bond;
        completed[j.agentId]++;
        emit Paid(jobId, j.agentId);
        _report(jobId, j, 100, tag);
    }

    function _slash(uint256 jobId, Job storage j, string memory tag) internal {
        j.state = State.Slashed;
        credits[j.buyer] += j.payment + j.bond;
        slashed[j.agentId]++;
        emit Slashed(jobId, j.agentId);
        _report(jobId, j, 0, tag);
    }

    /// Settlement is final before this runs; a failing registry can never block it.
    function _report(uint256 jobId, Job storage j, int128 value, string memory tag) internal {
        if (address(reputation) == address(0)) return;
        // Without this floor a caller could send just enough gas to settle but starve the
        // registry call, so a late agent could dodge its bad review.
        require(gasleft() > REPORT_GAS + 30_000, "low gas");
        try reputation.giveFeedback{gas: REPORT_GAS}(
            j.agentId, value, 0, "pledge", tag, "", "", keccak256(abi.encode(jobId, j.resultHash))
        ) {
            emit Reported(jobId, true);
        } catch {
            emit Reported(jobId, false);
        }
    }
}

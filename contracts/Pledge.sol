// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IIdentity {
    function ownerOf(uint256 agentId) external view returns (address);
}

/// Per-job bond for AI agents, keyed to an ERC-8004 identity.
/// Buyer escrows payment. Agent stakes a bond and must commit a result hash
/// before the deadline, or anyone can slash it to the buyer. If the judge goes
/// missing after the deadline, the agent can claim. No party can freeze funds.
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

    IIdentity public immutable identity;
    Job[] public jobs;
    mapping(address => uint256) public credits; // pull payments: a reverting receiver can't block settlement
    mapping(uint256 => uint256) public completed; // agentId => jobs delivered
    mapping(uint256 => uint256) public slashed; // agentId => jobs failed

    event Created(uint256 indexed jobId, address indexed buyer, uint256 indexed agentId, address judge, uint64 deadline, uint256 payment);
    event Accepted(uint256 indexed jobId, address agent, uint256 bond);
    event Committed(uint256 indexed jobId, bytes32 resultHash);
    event Paid(uint256 indexed jobId, uint256 indexed agentId);
    event Slashed(uint256 indexed jobId, uint256 indexed agentId);
    event Cancelled(uint256 indexed jobId);

    constructor(address _identity) {
        identity = IIdentity(_identity);
    }

    function create(uint256 agentId, address judge, uint64 deadline) external payable returns (uint256 jobId) {
        require(msg.value > 0, "no payment");
        require(deadline > block.timestamp, "bad deadline");
        jobId = jobs.length;
        jobs.push(Job(msg.sender, judge, agentId, address(0), msg.value, 0, deadline, 0, State.Open));
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

    function commit(uint256 jobId, bytes32 resultHash) external {
        Job storage j = jobs[jobId];
        require(j.state == State.Active, "not active");
        require(msg.sender == j.agent, "not agent");
        require(block.timestamp <= j.deadline, "too late");
        j.resultHash = resultHash;
        j.state = State.Committed;
        emit Committed(jobId, resultHash);
    }

    function confirm(uint256 jobId) external {
        Job storage j = _committedByJudge(jobId);
        _pay(jobId, j);
    }

    function reject(uint256 jobId) external {
        Job storage j = _committedByJudge(jobId);
        _slash(jobId, j);
    }

    /// Anyone can call once the deadline passes with no commit.
    function slash(uint256 jobId) external {
        Job storage j = jobs[jobId];
        require(j.state == State.Active, "not active");
        require(block.timestamp > j.deadline, "not late");
        _slash(jobId, j);
    }

    /// Judge absent: agent collects after the judge window.
    function claim(uint256 jobId) external {
        Job storage j = jobs[jobId];
        require(j.state == State.Committed, "not committed");
        require(block.timestamp > j.deadline + JUDGE_WINDOW, "judge window open");
        _pay(jobId, j);
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

    function _pay(uint256 jobId, Job storage j) internal {
        j.state = State.Paid;
        credits[j.agent] += j.payment + j.bond;
        completed[j.agentId]++;
        emit Paid(jobId, j.agentId);
    }

    function _slash(uint256 jobId, Job storage j) internal {
        j.state = State.Slashed;
        credits[j.buyer] += j.payment + j.bond;
        slashed[j.agentId]++;
        emit Slashed(jobId, j.agentId);
    }
}

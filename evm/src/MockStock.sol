// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// A stand-in for a Robinhood Stock Token, for tests and for the testnet faucet: a plain 18-decimal ERC-20 with the
/// issuer controls the real one has (pause, per-address block, an ERC-8056-style UI multiplier for dividends and
/// splits) plus an optional transfer fee, so the contract can be exercised against every behaviour it must survive.
/// Anyone may mint: this token has no value.
contract MockStock {
    string public name;
    string public symbol;
    uint8 public constant decimals = 18;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    address public owner;
    bool public paused;
    mapping(address => bool) public blocked;
    /// Applied to raw balances for display only, 1e18 = 1.0 (a 2:1 split doubles it).
    uint256 public uiMultiplier = 1e18;
    /// Skimmed from every transfer and burned; 0 for a Robinhood-like token.
    uint16 public feeBps;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    error IsPaused();
    error Blocked(address account);
    error InsufficientBalance();
    error InsufficientAllowance();
    error NotOwner();

    constructor(string memory name_, string memory symbol_) {
        name = name_;
        symbol = symbol_;
        owner = msg.sender;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier live(address a, address b) {
        if (paused) revert IsPaused();
        if (blocked[a]) revert Blocked(a);
        if (blocked[b]) revert Blocked(b);
        if (blocked[msg.sender]) revert Blocked(msg.sender);
        _;
    }

    function mint(address to, uint256 amount) external {
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function setPaused(bool p) external onlyOwner { paused = p; }
    function setBlocked(address a, bool b) external onlyOwner { blocked[a] = b; }
    function setMultiplier(uint256 m) external onlyOwner { uiMultiplier = m; }
    function setFeeBps(uint16 f) external onlyOwner { feeBps = f; }

    function balanceOfUI(address a) external view returns (uint256) {
        return balanceOf[a] * uiMultiplier / 1e18;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external live(msg.sender, to) returns (bool) {
        _move(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external live(from, to) returns (bool) {
        uint256 a = allowance[from][msg.sender];
        if (a != type(uint256).max) {
            if (a < amount) revert InsufficientAllowance();
            allowance[from][msg.sender] = a - amount;
        }
        _move(from, to, amount);
        return true;
    }

    function _move(address from, address to, uint256 amount) internal {
        if (balanceOf[from] < amount) revert InsufficientBalance();
        uint256 fee = amount * feeBps / 10_000;
        balanceOf[from] -= amount;
        balanceOf[to] += amount - fee;
        totalSupply -= fee;
        emit Transfer(from, to, amount - fee);
    }
}

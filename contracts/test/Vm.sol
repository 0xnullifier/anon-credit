// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity 0.8.30;

/// @notice The Foundry cheatcodes that the tests and the deploy script use.
/// @dev This file replaces forge-std, so that the project has no vendored library.
interface Vm {
    function prank(address sender) external;
    function deal(address account, uint256 balance) external;
    function warp(uint256 timestamp) external;
    function expectRevert(bytes calldata revertData) external;
    function expectEmit(bool checkTopic1, bool checkTopic2, bool checkTopic3, bool checkData, address emitter) external;
    function envAddress(string calldata name) external view returns (address);
    function envUint(string calldata name) external view returns (uint256);
    function envOr(string calldata name, uint256 defaultValue) external view returns (uint256);
    function setEnv(string calldata name, string calldata value) external;
    function startBroadcast() external;
    function stopBroadcast() external;
}

/// @notice Base contract for tests: the cheatcode handle and small assertions.
abstract contract TestBase {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    function assertEq(uint256 a, uint256 b, string memory message) internal pure {
        require(a == b, message);
    }

    function assertEq(bytes32 a, bytes32 b, string memory message) internal pure {
        require(a == b, message);
    }

    function assertEq(address a, address b, string memory message) internal pure {
        require(a == b, message);
    }
}

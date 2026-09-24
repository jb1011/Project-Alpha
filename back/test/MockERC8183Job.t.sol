// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * THE TEST DOUBLE'S REFUND RULES, EXECUTED.
 *
 * `MockERC8183Job` is the contract every anvil integration test funds an escrow against, so a
 * rule it gets wrong is a rule the backend is tested against wrongly. The two paths that give a
 * client its money back are exactly the ones where that matters most: `reject` is gated on WHO
 * calls it and on WHICH status, `claimRefund` on a deadline — and a double that simply transferred
 * the budget to whoever asked would make the backend's own role and expiry checks untestable.
 *
 * The rules asserted here are the deployed implementation's (Arc testnet
 * 0xa316fd02827242d537f84730f8a37d0ba5fd351a, selectors confirmed 2026-09-24):
 *   reject       — the CLIENT may reject an Open job; the EVALUATOR a Funded or Submitted one;
 *                  nobody else may; a Funded/Submitted reject refunds the client; status -> 4.
 *   claimRefund  — ANYONE may expire a Funded or Submitted job once `expiredAt` has passed;
 *                  it refunds the client; status -> 5.
 *
 * There was no pattern for testing a mock in `back/test` (every other .t.sol tests a production
 * contract and uses the mocks as doubles), so this file follows the forge-std `Test` shape the
 * rest of the suite uses.
 */

import {Test} from "forge-std/Test.sol";
import {MockERC8183Job} from "./mocks/MockERC8183Job.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";

contract MockERC8183JobRefundTest is Test {
    MockUSDC internal usdc;
    MockERC8183Job internal job;

    address internal client = makeAddr("client");
    address internal provider = makeAddr("provider");
    address internal evaluator = makeAddr("evaluator");
    address internal stranger = makeAddr("stranger");

    uint256 internal constant BUDGET = 500_000; // 0.5 USDC
    uint256 internal constant EXPIRES_AT = 1_000_000;

    function setUp() public {
        usdc = new MockUSDC();
        job = new MockERC8183Job(address(usdc));
        usdc.mint(client, BUDGET);
    }

    /// An Open job: created, budget set by the provider, nothing funded yet.
    function _open() internal returns (uint256 jobId) {
        vm.prank(client);
        jobId = job.createJob(provider, evaluator, EXPIRES_AT, "demo", address(0));
        vm.prank(provider);
        job.setBudget(jobId, BUDGET, "");
    }

    /// A Funded job: the client's budget is in the contract's escrow.
    function _funded() internal returns (uint256 jobId) {
        jobId = _open();
        vm.prank(client);
        usdc.approve(address(job), BUDGET);
        vm.prank(client);
        job.fund(jobId, "");
    }

    /// A Submitted job: funded, then the provider handed in a deliverable.
    function _submitted() internal returns (uint256 jobId) {
        jobId = _funded();
        vm.prank(provider);
        job.submit(jobId, keccak256("deliverable"), "");
    }

    // ── reject ───────────────────────────────────────────────────────────────────────────────

    function test_ClientRejectsOpenJob() public {
        uint256 jobId = _open();
        vm.prank(client);
        job.reject(jobId, keccak256("reason"), "");
        assertEq(job.getJob(jobId).status, 4);
        // Nothing was escrowed, so nothing moved: the client still holds the whole budget.
        assertEq(usdc.balanceOf(client), BUDGET);
        assertEq(usdc.balanceOf(address(job)), 0);
    }

    function test_EvaluatorRejectsFundedJobAndTheClientIsRepaid() public {
        uint256 jobId = _funded();
        assertEq(usdc.balanceOf(address(job)), BUDGET);
        vm.prank(evaluator);
        job.reject(jobId, keccak256("reason"), "");
        assertEq(job.getJob(jobId).status, 4);
        assertEq(usdc.balanceOf(client), BUDGET);
        assertEq(usdc.balanceOf(address(job)), 0);
    }

    function test_EvaluatorRejectsSubmittedJobAndTheClientIsRepaid() public {
        uint256 jobId = _submitted();
        vm.prank(evaluator);
        job.reject(jobId, keccak256("reason"), "");
        assertEq(job.getJob(jobId).status, 4);
        assertEq(usdc.balanceOf(client), BUDGET);
        assertEq(usdc.balanceOf(address(job)), 0);
    }

    function test_ClientCannotRejectAFundedJob() public {
        uint256 jobId = _funded();
        vm.prank(client);
        vm.expectRevert(bytes("client: not open"));
        job.reject(jobId, keccak256("reason"), "");
        assertEq(job.getJob(jobId).status, 1);
        assertEq(usdc.balanceOf(address(job)), BUDGET);
    }

    function test_EvaluatorCannotRejectAnOpenJob() public {
        uint256 jobId = _open();
        vm.prank(evaluator);
        vm.expectRevert(bytes("evaluator: not funded or submitted"));
        job.reject(jobId, keccak256("reason"), "");
        assertEq(job.getJob(jobId).status, 0);
    }

    function test_AStrangerCannotReject() public {
        uint256 jobId = _funded();
        vm.prank(stranger);
        vm.expectRevert(bytes("not client or evaluator"));
        job.reject(jobId, keccak256("reason"), "");
        assertEq(job.getJob(jobId).status, 1);
        assertEq(usdc.balanceOf(address(job)), BUDGET);
    }

    function test_TheProviderCannotReject() public {
        uint256 jobId = _funded();
        vm.prank(provider);
        vm.expectRevert(bytes("not client or evaluator"));
        job.reject(jobId, keccak256("reason"), "");
        assertEq(job.getJob(jobId).status, 1);
    }

    function test_ARejectedJobCannotBeRejectedTwice() public {
        uint256 jobId = _funded();
        vm.prank(evaluator);
        job.reject(jobId, keccak256("reason"), "");
        vm.prank(evaluator);
        vm.expectRevert(bytes("evaluator: not funded or submitted"));
        job.reject(jobId, keccak256("reason"), "");
        // One refund, not two: the escrow is empty and the client was paid exactly once.
        assertEq(usdc.balanceOf(client), BUDGET);
    }

    // ── claimRefund ──────────────────────────────────────────────────────────────────────────

    function test_AnyoneClaimsTheRefundOfAnExpiredFundedJob() public {
        uint256 jobId = _funded();
        vm.warp(EXPIRES_AT + 1);
        vm.prank(stranger);
        job.claimRefund(jobId);
        assertEq(job.getJob(jobId).status, 5);
        // The money goes to the CLIENT, never to the caller.
        assertEq(usdc.balanceOf(client), BUDGET);
        assertEq(usdc.balanceOf(stranger), 0);
        assertEq(usdc.balanceOf(address(job)), 0);
    }

    function test_AnExpiredSubmittedJobIsAlsoRefundable() public {
        uint256 jobId = _submitted();
        vm.warp(EXPIRES_AT + 1);
        vm.prank(client);
        job.claimRefund(jobId);
        assertEq(job.getJob(jobId).status, 5);
        assertEq(usdc.balanceOf(client), BUDGET);
    }

    function test_ClaimRefundRefusesBeforeTheDeadline() public {
        uint256 jobId = _funded();
        vm.warp(EXPIRES_AT);
        vm.prank(client);
        vm.expectRevert(bytes("not expired"));
        job.claimRefund(jobId);
        assertEq(job.getJob(jobId).status, 1);
        assertEq(usdc.balanceOf(address(job)), BUDGET);
    }

    function test_ClaimRefundRefusesAnOpenJob() public {
        uint256 jobId = _open();
        vm.warp(EXPIRES_AT + 1);
        vm.prank(client);
        vm.expectRevert(bytes("not funded or submitted"));
        job.claimRefund(jobId);
        assertEq(job.getJob(jobId).status, 0);
    }

    function test_ClaimRefundRefusesACompletedJob() public {
        uint256 jobId = _submitted();
        vm.prank(evaluator);
        job.complete(jobId, keccak256("reason"), "");
        assertEq(usdc.balanceOf(provider), BUDGET);
        vm.warp(EXPIRES_AT + 1);
        vm.prank(client);
        vm.expectRevert(bytes("not funded or submitted"));
        job.claimRefund(jobId);
        assertEq(job.getJob(jobId).status, 3);
        // The provider keeps what `complete` paid out.
        assertEq(usdc.balanceOf(provider), BUDGET);
        assertEq(usdc.balanceOf(client), 0);
    }

    function test_ARefundedJobCannotBeClaimedTwice() public {
        uint256 jobId = _funded();
        vm.warp(EXPIRES_AT + 1);
        vm.prank(stranger);
        job.claimRefund(jobId);
        vm.prank(stranger);
        vm.expectRevert(bytes("not funded or submitted"));
        job.claimRefund(jobId);
        assertEq(usdc.balanceOf(client), BUDGET);
    }
}

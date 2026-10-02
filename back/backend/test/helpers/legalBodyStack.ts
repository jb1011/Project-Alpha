import {
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
  getAddress,
  padHex,
  toFunctionSelector,
} from "viem";
import { noviControllerAbi } from "../../src/abis/generated";
import { loadArtifact } from "./artifacts";

/** The legal-body contracts on a local chain, wired the way a deployment wires them. */
export interface LegalBodyStack {
  registry: Address;
  implementation: Address;
  controller: Address;
  factory: Address;
}

/**
 * The factory functions the executor relays, with their selectors written out from the Solidity
 * signatures. Spelled here, not taken from the backend's own list, so the boot check that compares
 * that list with the chain is checked against an independent source.
 */
export const LEGAL_BODY_FACTORY_SELECTORS = {
  createLegalBody: toFunctionSelector(
    "createLegalBody(uint256,address,uint256,bytes32,uint256,bytes)",
  ),
  scheduleOperatingAgreementUpdate: toFunctionSelector(
    "scheduleOperatingAgreementUpdate(address,bytes32,uint256,bytes)",
  ),
} as const;

/** The controller's role for a selector: the four bytes LEFT-aligned in a bytes32. */
export function controllerRole(selector: Hex): Hex {
  return padHex(selector, { dir: "right", size: 32 });
}

/** Deploy a contract from its Foundry artifact (`back/out`) and wait for it to be mined. */
export async function deployContract(
  wallet: WalletClient,
  pub: PublicClient,
  name: string,
  // biome-ignore lint/suspicious/noExplicitAny: constructor args vary by contract
  args: any[] = [],
): Promise<Address> {
  const { abi, bytecode } = loadArtifact(name);
  const hash = await wallet.deployContract({
    abi,
    bytecode,
    args,
    account: wallet.account!,
    chain: wallet.chain,
  });
  const receipt = await pub.waitForTransactionReceipt({ hash });
  if (!receipt.contractAddress) throw new Error(`${name} deploy produced no address`);
  return getAddress(receipt.contractAddress);
}

/** One admin call on the controller, mined before it returns. */
async function asControllerAdmin(
  p: { admin: WalletClient; pub: PublicClient; controller: Address },
  call: {
    functionName: "setBoundTarget" | "grantRole" | "revokeRole";
    args: readonly [Hex, Address];
  },
): Promise<void> {
  const hash = await p.admin.writeContract({
    address: p.controller,
    abi: noviControllerAbi,
    functionName: call.functionName,
    args: call.args,
    account: p.admin.account!,
    chain: p.admin.chain,
  });
  const receipt = await p.pub.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`controller ${call.functionName} reverted`);
}

/** The admin lets `account` relay `selector` through the controller. */
export function grantSelector(p: {
  admin: WalletClient;
  pub: PublicClient;
  controller: Address;
  selector: Hex;
  account: Address;
}): Promise<void> {
  return asControllerAdmin(p, {
    functionName: "grantRole",
    args: [controllerRole(p.selector), p.account],
  });
}

/** The admin withdraws `account`'s right to relay `selector` through the controller. */
export function revokeSelector(p: {
  admin: WalletClient;
  pub: PublicClient;
  controller: Address;
  selector: Hex;
  account: Address;
}): Promise<void> {
  return asControllerAdmin(p, {
    functionName: "revokeRole",
    args: [controllerRole(p.selector), p.account],
  });
}

/**
 * The legal-body stack on a local anvil: the mock identity registry, the LegalManager
 * implementation, the REAL NoviController with no standing grant, and the REAL LegalBodyFactory
 * owned by that controller. Then the admin's ceremony: each factory selector is pinned to the
 * factory first, and only then granted to the executor, so no selector is ever relayable to
 * another target.
 */
export async function deployLegalBodyStack(p: {
  deployer: WalletClient;
  admin: WalletClient;
  pub: PublicClient;
  executor: Address;
}): Promise<LegalBodyStack> {
  const registry = await deployContract(p.deployer, p.pub, "MockIdentityRegistry");
  const implementation = await deployContract(p.deployer, p.pub, "LegalManager");
  const controller = await deployContract(p.deployer, p.pub, "NoviController", [
    86_400, // the admin handover delay
    p.admin.account!.address,
    p.executor,
    [], // no standing grant at construction
    [],
    [],
  ]);
  const factory = await deployContract(p.deployer, p.pub, "LegalBodyFactory", [
    implementation,
    registry,
    controller,
  ]);

  const selectors = Object.values(LEGAL_BODY_FACTORY_SELECTORS);
  const ctl = { admin: p.admin, pub: p.pub, controller };
  for (const selector of selectors)
    await asControllerAdmin(ctl, { functionName: "setBoundTarget", args: [selector, factory] });
  for (const selector of selectors) await grantSelector({ ...ctl, selector, account: p.executor });
  return { registry, implementation, controller, factory };
}

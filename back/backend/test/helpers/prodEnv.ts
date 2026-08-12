/** Shared env fixtures for config tests — one definition of "a full credential set", so the boot
 *  invariants can tighten without hunting pasted copies across test files. */

/** Core Turnkey config WITHOUT the delegated keypair — legacy shared-operator signing works,
 *  per-agent vault provisioning does not (canProvisionTurnkey = false). */
export const TURNKEY_CORE_ENV = {
  TURNKEY_API_PUBLIC_KEY: "pub",
  TURNKEY_API_PRIVATE_KEY: "priv",
  TURNKEY_ORGANIZATION_ID: "org",
  TURNKEY_SIGN_WITH: "0xabc",
};

/** Everything vault provisioning needs (canProvisionTurnkey = true). */
export const TURNKEY_FULL_ENV = {
  ...TURNKEY_CORE_ENV,
  TURNKEY_DELEGATED_API_PUBLIC_KEY: "dpub",
  TURNKEY_DELEGATED_API_PRIVATE_KEY: "dpriv",
};

/** Everything a circle-default deployment needs to pass the boot invariant. */
export const CIRCLE_FULL_ENV = {
  CIRCLE_API_KEY: "ck_test",
  CIRCLE_ENTITY_SECRET: "es_test",
  CIRCLE_WALLET_SET_ID: "ws_test",
};

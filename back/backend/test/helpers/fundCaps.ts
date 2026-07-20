import { usdToUnits } from "../../src/policy/units";

/**
 * Default `OnboardingRunner` fund caps for tests that don't care about the S1 ceilings — mirrors
 * the production defaults (`MAX_TREASURY_FUND_USDC=25`, `MAX_TREASURY_FUNDED_PER_TENANT_USDC=100`).
 * Cap-specific tests should construct a tighter `{ perCall, perTenantTotal }` inline instead.
 */
export const TEST_FUND_CAPS = { perCall: usdToUnits("25"), perTenantTotal: usdToUnits("100") };

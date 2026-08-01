import { expect, test, vi } from "vitest";
import { opsLog } from "../../src/observability/opsLog";

test("emits exactly one grep-able JSON line with the event and fields", () => {
  const spy = vi.spyOn(console, "log").mockImplementation(() => {});
  opsLog("outflow_recorded", { path: "gas_seed", amount: "400000" });
  expect(spy).toHaveBeenCalledTimes(1);
  const parsed = JSON.parse(String(spy.mock.calls[0]?.[0]));
  expect(parsed.opslog).toBe("outflow_recorded");
  expect(parsed.path).toBe("gas_seed");
  expect(parsed.at).toBeTruthy();
  spy.mockRestore();
});

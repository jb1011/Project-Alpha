/**
 * The customer's MCP client for the three Hedera tools the Novi Corpus backend exposes.
 *
 * The server answers DECISIONS and records what already happened; it never signs and never
 * receives a key (design D1, D2). Every answer is a JSON document in `content[0].text`.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

/** `check_policy`'s answer. `available` is the float balance in atomic USDC. */
export type PolicyVerdict = { ok: true; available: string } | { ok: false; reason: string };

/** `report_payment`'s answer, keyed on `status`. */
export type PaymentReport =
  | { status: "settled"; ledgerId?: number; duplicate?: boolean }
  | { status: "pending" }
  | { status: "failed"; reason: string; duplicate?: boolean };

/** `link_hedera_account`'s answer. */
export type LinkResult =
  | { ok: true; accountId: string; guardianPublicKey: string }
  | { ok: false; reason: string };

export type CheckPolicyArgs = {
  id: string;
  payee: string;
  amountUsdc: string;
  network: string;
};

export type ReportPaymentArgs = CheckPolicyArgs & {
  transactionId: string;
  idempotencyKey: string;
};

export type LinkHederaAccountArgs = { id: string; accountId: string; publicKey: string };

/** The three tools, as typed functions. Stubbed wholesale in the tests. */
export interface NoviClient {
  checkPolicy(args: CheckPolicyArgs): Promise<PolicyVerdict>;
  reportPayment(args: ReportPaymentArgs): Promise<PaymentReport>;
  linkHederaAccount(args: LinkHederaAccountArgs): Promise<LinkResult>;
}

/** A live `NoviClient` holds a transport, so it also has to be closed. */
export interface NoviClientHandle extends NoviClient {
  close(): Promise<void>;
}

/** The tool answer shape every one of the three returns. */
type ToolAnswer = { content?: Array<{ type: string; text?: string }>; isError?: boolean };

/**
 * Connects an MCP client to a Novi Corpus backend over streamable HTTP.
 *
 * @param o - Endpoint and credential
 * @param o.mcpUrl - The `/mcp` endpoint (local backend for pre-merge checks, prod for the demo)
 * @param o.apiKey - A Novi Corpus API key with the `spend` capability
 * @returns The three tools plus `close`
 */
export function createNoviClient(o: { mcpUrl: string; apiKey: string }): NoviClientHandle {
  const client = new Client({ name: "novi-hedera-client", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(o.mcpUrl), {
    requestInit: { headers: { authorization: `Bearer ${o.apiKey}` } },
  });
  let connected: Promise<void> | undefined;
  const ready = () => {
    connected ??= client.connect(transport);
    return connected;
  };

  /**
   * Calls one tool and parses its single text block as JSON.
   *
   * @param name - The tool name, exactly as the server registers it
   * @param args - The tool's arguments
   * @returns The parsed answer
   */
  async function call<T>(name: string, args: Record<string, unknown>): Promise<T> {
    await ready();
    const res = (await client.callTool({ name, arguments: args })) as ToolAnswer;
    const text = res.content?.[0]?.text;
    // An `isError` answer carries a bare sentence ("not found", "invalid amountUsdc"), not
    // JSON. Throwing keeps it from being parsed into something that reads like a verdict.
    if (res.isError) throw new Error(`${name}: ${text ?? "tool error"}`);
    if (typeof text !== "string") throw new Error(`${name}: no text content in the answer`);
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error(`${name}: answer is not JSON: ${text}`);
    }
  }

  return {
    checkPolicy: (args) => call<PolicyVerdict>("check_policy", { ...args }),
    reportPayment: (args) => call<PaymentReport>("report_payment", { ...args }),
    linkHederaAccount: (args) => call<LinkResult>("link_hedera_account", { ...args }),
    async close() {
      if (connected) await client.close();
    },
  };
}

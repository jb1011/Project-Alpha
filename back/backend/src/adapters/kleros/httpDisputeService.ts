/**
 * The Kleros Dispute Service over raw HTTP JSON-RPC: the real client, one instance per key.
 *
 * The service is one authenticated endpoint that takes one JSON-RPC object per POST and answers
 * in one SSE frame (Kleros docs, "Calling the service as raw HTTP JSON-RPC"). No MCP session is
 * opened: every call stands alone, so there is nothing to keep alive or resume.
 *
 * The writes create real, public and permanent disputes, so three guards matter more than the
 * parsing:
 *
 * - **One deployment per instance.** The key decides where a dispute is filed, and a read names
 *   its chain every time (an omitted chain fans out over ethereum, gnosis and arbitrum-one and
 *   never reaches the testnet). A read naming another chain is refused before any request: it
 *   would read someone else's case.
 * - **One write at a time per key.** The service does not queue a second write; it answers
 *   `WRITE_IN_PROGRESS` (nothing sent). Writes therefore take a per-key lock, and that refusal is
 *   waited out rather than reported.
 * - **No blind repeat of a filing or a submission.** Only the pin is retried (the same bytes give
 *   the same CID and nothing is spent). `dispute_create` and `evidence_submit` go out once; any
 *   failure but a "nothing sent" refusal is the caller's "maybe sent".
 *
 * The key never leaves this module except in the `authorization` header: it is held in private
 * fields, hashed for the lock name, and scrubbed from any error text that is not the service's.
 */
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import type { Address, Hex } from "viem";
import { opsLog } from "../../observability/opsLog";
import { withKeyedLock } from "../../payments/keyedMutex";
import { withDeadline } from "../../util/deadline";
import {
  type KlerosChain,
  type KlerosDeploymentName,
  type KlerosReadChain,
  deploymentFor,
} from "./deployments";
import type {
  CourtClock,
  CreateOutcome,
  DisputeRead,
  KlerosDisputeService,
  PinOutcome,
  SubmitOutcome,
} from "./disputeService";
import {
  KlerosHttpError,
  KlerosRefusal,
  KlerosTransportError,
  KlerosWrongDeploymentError,
  PRESET_SIMULATES,
  type WriteTool,
  sentOf,
} from "./errors";

export interface HttpDisputeServiceDeps {
  apiUrl: string;
  apiKey: string;
  /** The one deployment this instance may read; the key must be that deployment's. */
  deployment: KlerosDeploymentName;
  fetch?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Default 20, under the 30 per minute Kleros meters per key. */
  requestsPerMinute?: number;
  /** Per POST. Defaults: reads 30 s, pin 120 s, create and submit 240 s. */
  deadlines?: { readMs?: number; pinMs?: number; createMs?: number; submitMs?: number };
}

type Payload = Record<string, unknown>;

const WINDOW_MS = 60_000;
const DEFAULT_REQUESTS_PER_MINUTE = 20;
/** The service stops a filing itself at three minutes; 240 s leaves room for its answer. */
const DEFAULT_DEADLINES = { readMs: 30_000, pinMs: 120_000, createMs: 240_000, submitMs: 240_000 };
/** A 429 carries no Retry-After (Kleros docs): back off blindly, once, and only on a read. */
const RATE_LIMITED_WAIT_MS = 15_000;
const READ_BACKOFF_MS = [2_000, 5_000] as const;
const PIN_RETRIES = 3;
const WRITE_IN_PROGRESS = "WRITE_IN_PROGRESS";
const WRITE_IN_PROGRESS_WAIT_MS = 5_000;
const WRITE_IN_PROGRESS_MAX_MS = 120_000;
const MAX_TOOL_PAGES = 5;
const HTTP_BODY_KEPT = 500;
/** How much of the service's text a failed filing or submission carries in its error. */
const SERVICE_TEXT_KEPT = 4_000;
const LOCAL_ID_KEPT = 200;
/** setTimeout holds at most a signed 32-bit delay; a longer one is clamped to 1 ms. */
const MAX_TIMER_MS = 2_147_483_647;
/** The two writes that spend on a chain: a failure to read their answer must keep the answer. */
const CHAIN_WRITES: readonly string[] = ["dispute_create", "evidence_submit"];
const SIMULATED = `${PRESET_SIMULATES}: the key simulated the write; nothing was sent`;
const PERIODS: readonly string[] = ["Evidence", "Commit", "Vote", "Appeal", "Executed"];
const INITIALIZE_PARAMS = {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "novi-pilot", version: "0" },
};

export class HttpDisputeService implements KlerosDisputeService {
  readonly deployment: KlerosDeploymentName;
  readonly #chain: KlerosChain;
  readonly #apiUrl: string;
  readonly #apiKey: string;
  readonly #writeLock: string;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #perMinute: number;
  readonly #deadlines: typeof DEFAULT_DEADLINES;
  /** Start times of the POSTs in the current window, oldest first. */
  readonly #starts: number[] = [];
  #nextId = 1;

  constructor(d: HttpDisputeServiceDeps) {
    this.deployment = d.deployment;
    this.#chain = deploymentFor(d.deployment).chain;
    this.#apiUrl = d.apiUrl;
    if (typeof d.apiKey !== "string" || d.apiKey.trim() === "") {
      throw new Error("Kleros apiKey is empty");
    }
    this.#apiKey = d.apiKey;
    // The service runs one write at a time per key, so the lock is per key (not per instance),
    // named by a hash so the key itself never sits in the lock table.
    const fingerprint = createHash("sha256").update(d.apiKey).digest("hex").slice(0, 16);
    this.#writeLock = `kleros-write:${fingerprint}`;
    this.#fetch = d.fetch ?? ((input, init) => fetch(input, init));
    this.#now = d.now ?? Date.now;
    this.#sleep = d.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.#perMinute = d.requestsPerMinute ?? DEFAULT_REQUESTS_PER_MINUTE;
    if (!Number.isSafeInteger(this.#perMinute) || this.#perMinute <= 0) {
      throw new Error("Kleros requestsPerMinute must be a positive integer");
    }
    // Field by field, so an explicit undefined from config keeps the default. A deadline that is
    // not a positive number would fire as soon as a filing is on the wire and turn every filing
    // into "maybe sent", so it is refused here, before anything is sent.
    const given = d.deadlines ?? {};
    this.#deadlines = {
      readMs: given.readMs ?? DEFAULT_DEADLINES.readMs,
      pinMs: given.pinMs ?? DEFAULT_DEADLINES.pinMs,
      createMs: given.createMs ?? DEFAULT_DEADLINES.createMs,
      submitMs: given.submitMs ?? DEFAULT_DEADLINES.submitMs,
    };
    for (const [name, ms] of Object.entries(this.#deadlines)) {
      if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0 || ms > MAX_TIMER_MS) {
        throw new Error(
          `Kleros deadline ${name} must be a positive number of milliseconds, ` +
            `at most ${MAX_TIMER_MS}`,
        );
      }
    }
  }

  async listTools(): Promise<string[]> {
    const names: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_TOOL_PAGES; page++) {
      const params = cursor === undefined ? {} : { cursor };
      const { tools, next } = await this.#read(async () =>
        toolsPageOf(await this.#post("tools/list", "tools/list", params, this.#deadlines.readMs)),
      );
      names.push(...tools);
      if (next === undefined) break;
      cursor = next;
    }
    return names;
  }

  /**
   * The raw-HTTP guide says `initialize` is not needed, not that it is refused, so this asks
   * once and settles for null on any other answer. It never retries and keeps nothing: no
   * `notifications/initialized` follows.
   */
  async instructions(): Promise<string | null> {
    let reason: string;
    try {
      const result = await this.#post(
        "initialize",
        "initialize",
        INITIALIZE_PARAMS,
        this.#deadlines.readMs,
      );
      if (typeof result.instructions === "string") return result.instructions;
      reason = "the initialize result carries no instructions string";
    } catch (e) {
      reason =
        e instanceof KlerosHttpError
          ? `HTTP ${e.status}`
          : this.#scrub(e instanceof Error ? e.message : String(e));
    }
    try {
      opsLog("kleros_instructions_unavailable", { deployment: this.deployment, reason });
    } catch {
      // observe, never gate
    }
    return null;
  }

  async getCourt(p: { chain: KlerosReadChain; courtId: number }): Promise<CourtClock> {
    const chain = this.#ownChain(p.chain);
    return this.#read(() =>
      this.#callTool("court_get", { chain, id: String(p.courtId) }, this.#deadlines.readMs, (pl) =>
        courtClockOf(pl, p.courtId),
      ),
    );
  }

  async getDispute(p: { chain: KlerosReadChain; coreDisputeId: string }): Promise<DisputeRead> {
    const chain = this.#ownChain(p.chain);
    return this.#read(() =>
      this.#callTool("dispute_get", { id: p.coreDisputeId, chain }, this.#deadlines.readMs, (pl) =>
        disputeReadOf(pl, chain, p.coreDisputeId),
      ),
    );
  }

  async pin(p: { bytes: Uint8Array; extension: string }): Promise<PinOutcome> {
    // Standard padded base64 (RFC 4648 section 4): the service refuses base64url and data: URIs
    // rather than decoding them leniently.
    const attachment = Buffer.from(p.bytes).toString("base64");
    return this.#write(
      "evidence_pin",
      { attachment, extension: p.extension },
      this.#deadlines.pinMs,
      pinOutcomeOf,
    );
  }

  async createDispute(p: { aliases: Record<string, Address> }): Promise<CreateOutcome> {
    return this.#write(
      "dispute_create",
      { aliases: p.aliases },
      this.#deadlines.createMs,
      (pl, text) =>
        createOutcomeOf(pl, text, (coreDisputeId, raw) =>
          this.#noteUnreadableLocalId(coreDisputeId, raw),
        ),
    );
  }

  async submitEvidence(p: {
    coreDisputeId: string;
    name: string;
    description: string;
    fileUri?: string;
    fileTypeExtension?: string;
  }): Promise<SubmitOutcome> {
    // The optional pair is left out rather than sent undefined: the service refuses
    // fileTypeExtension without fileUri.
    const args: Record<string, unknown> = {
      dispute: p.coreDisputeId,
      name: p.name,
      description: p.description,
    };
    if (p.fileUri !== undefined) args.fileUri = p.fileUri;
    if (p.fileTypeExtension !== undefined) args.fileTypeExtension = p.fileTypeExtension;
    return this.#write("evidence_submit", args, this.#deadlines.submitMs, submitOutcomeOf);
  }

  /** The instance's chain, or a refusal before any request ("fake" included). */
  #ownChain(chain: KlerosReadChain): KlerosChain {
    if (chain !== this.#chain) throw new KlerosWrongDeploymentError(this.#chain, chain);
    return this.#chain;
  }

  /**
   * A read: a 429 waits 15 s and retries once; a transport error retries twice, after 2 s and
   * 5 s. Anything else (a refusal, another HTTP status) is an answer and is thrown.
   */
  async #read<T>(attempt: () => Promise<T>): Promise<T> {
    let backoff = 0;
    let rateLimited = false;
    for (;;) {
      try {
        return await attempt();
      } catch (e) {
        if (e instanceof KlerosHttpError && e.status === 429 && !rateLimited) {
          rateLimited = true;
          await this.#sleep(RATE_LIMITED_WAIT_MS);
        } else if (e instanceof KlerosTransportError && backoff < READ_BACKOFF_MS.length) {
          await this.#sleep(READ_BACKOFF_MS[backoff++]!);
        } else {
          throw e;
        }
      }
    }
  }

  /**
   * A write, under the per-key lock. `WRITE_IN_PROGRESS` means nothing was sent, so it is waited
   * out (5 s at a time, up to 120 s) on every write tool. Only the pin retries anything else,
   * and never a 429: the limiter should have prevented it, and the docs' "retry" for the pin is
   * about the upload, not about the per-key rate.
   */
  #write<T>(
    tool: WriteTool,
    args: Record<string, unknown>,
    ms: number,
    outcome: (payload: Payload, text: string) => T,
  ): Promise<T> {
    return withKeyedLock(this.#writeLock, async () => {
      let pinRetries = 0;
      let waitingSince: number | undefined;
      for (;;) {
        try {
          return await this.#callTool(tool, args, ms, outcome);
        } catch (e) {
          if (e instanceof KlerosRefusal && e.code === WRITE_IN_PROGRESS) {
            const now = this.#now();
            waitingSince ??= now;
            if (now - waitingSince + WRITE_IN_PROGRESS_WAIT_MS > WRITE_IN_PROGRESS_MAX_MS) throw e;
            await this.#sleep(WRITE_IN_PROGRESS_WAIT_MS);
          } else if (tool === "evidence_pin" && pinRetries < PIN_RETRIES && pinMayRetry(e)) {
            pinRetries++;
          } else {
            // The window should keep every write under the meter, so a 429 here is worth a line.
            if (e instanceof KlerosHttpError && e.status === 429) this.#noteWriteRateLimited(tool);
            throw e;
          }
        }
      }
    });
  }

  /**
   * tools/call, then `isError`, then the payload (the last JSON object of `content[0].text`),
   * then `map` into the outcome; `text` is every `content[].text`, joined.
   *
   * A filing or a submission that answered and could not be read may still have spent: a mined
   * dispute exists whether or not its payload parses here. So on those two tools a failure to
   * read the answer carries the service's own text in its message, and with it the core id and
   * the transaction hash the caller needs to resolve the case by hand.
   */
  async #callTool<T>(
    tool: string,
    args: Record<string, unknown>,
    ms: number,
    map: (payload: Payload, text: string) => T,
  ): Promise<T> {
    const result = await this.#post(tool, "tools/call", { name: tool, arguments: args }, ms);
    const content = Array.isArray(result.content) ? result.content : [];
    const texts = content.map((c) => (isRecord(c) && typeof c.text === "string" ? c.text : ""));
    const text = texts.filter((t) => t !== "").join("\n");
    // A refusal is rendered prose with no code field: it is read before the payload, which
    // would otherwise fail on it as bad JSON.
    if (result.isError === true) throw new KlerosRefusal(tool, text);
    try {
      const first = content[0];
      if (!isRecord(first) || typeof first.text !== "string") {
        throw new KlerosTransportError(`Kleros ${tool} answered no text content`);
      }
      let payload: Payload;
      try {
        payload = parseToolPayload(first.text) as Payload;
      } catch (e) {
        throw new KlerosTransportError(`Kleros ${tool}: ${(e as Error).message}`);
      }
      return map(payload, text);
    } catch (e) {
      if (!(e instanceof KlerosTransportError) || !CHAIN_WRITES.includes(tool)) throw e;
      throw this.#withServiceText(e, text);
    }
  }

  /**
   * The same transport error with the service's text appended, scrubbed before it is cut (so no
   * part of a key survives at the cut) and cut at 4,000 characters.
   */
  #withServiceText(e: KlerosTransportError, text: string): KlerosTransportError {
    const clean = this.#scrub(text);
    const shown =
      clean.length > SERVICE_TEXT_KEPT ? `${clean.slice(0, SERVICE_TEXT_KEPT)} [cut]` : clean;
    return new KlerosTransportError(
      `${e.message}. The service answered: ${shown === "" ? "(no text)" : shown}`,
    );
  }

  /**
   * One POST, one JSON-RPC object (a batch is refused at any size), its JSON-RPC `result`. The
   * deadline covers the fetch and the body read, and its signal aborts the request. The status
   * is read first: 401, 429 and 413 are plain JSON decided before JSON-RPC. Redirects are not
   * followed: a 307 or 308 would send a filing a second time inside one fetch.
   *
   * A filing or a submission whose 200 answer cannot be read keeps the body in the error, for the
   * same reason `#callTool` keeps the tool's text: the dispute may exist and may have been paid.
   */
  async #post(label: string, method: string, params: unknown, ms: number): Promise<Payload> {
    await this.#admit();
    const id = this.#nextId++;
    const body = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    const { status, text } = await withDeadline(
      ms,
      async (signal) => {
        try {
          const res = await this.#fetch(this.#apiUrl, {
            method: "POST",
            headers: {
              authorization: `Bearer ${this.#apiKey}`,
              "content-type": "application/json",
              // Both media types, or the service answers 406 before reading the request.
              accept: "application/json, text/event-stream",
            },
            body,
            signal,
            redirect: "error",
          });
          return { status: res.status, text: await res.text() };
        } catch (e) {
          throw new KlerosTransportError(
            `Kleros ${label} request failed: ${this.#scrub(errorText(e))}`,
          );
        }
      },
      () => new KlerosTransportError(`Kleros ${label} did not answer within ${ms} ms`),
    );
    // Scrubbed before it is cut: a proxy's error page may echo the request's headers.
    if (status !== 200)
      throw new KlerosHttpError(status, this.#scrub(text).slice(0, HTTP_BODY_KEPT));
    try {
      return resultOf(text, id, label);
    } catch (e) {
      if (!(e instanceof KlerosTransportError)) throw e;
      // A JSON-RPC error's message is copied from the body, which an intermediary may have built
      // from the request's headers: the message is scrubbed too, not only the appended body.
      const clean = new KlerosTransportError(this.#scrub(e.message));
      throw CHAIN_WRITES.includes(label) ? this.#withServiceText(clean, text) : clean;
    }
  }

  /**
   * A sliding window: at most `requestsPerMinute` POSTs start in any rolling 60 s. A refilling
   * bucket would admit up to twice its size within one minute, over the per-key meter. Every
   * POST counts: retries, `initialize` and each `tools/list` page.
   */
  async #admit(): Promise<void> {
    for (;;) {
      const now = this.#now();
      while (this.#starts.length > 0 && now - this.#starts[0]! >= WINDOW_MS) this.#starts.shift();
      if (this.#starts.length < this.#perMinute) {
        this.#starts.push(now);
        return;
      }
      await this.#sleep(this.#starts[0]! + WINDOW_MS - now);
    }
  }

  /**
   * The docs: a mined filing's payload is the only place `localDisputeID` appears. One that is
   * present but unreadable leaves the outcome mined (the core id is good) and goes to the ops log
   * as received, so an operator can still recover it.
   */
  #noteUnreadableLocalId(coreDisputeId: string, raw: unknown): void {
    const shown = typeof raw === "string" ? raw : (JSON.stringify(raw) ?? String(raw));
    try {
      opsLog("kleros_local_dispute_id_unreadable", {
        deployment: this.deployment,
        coreDisputeId,
        localDisputeID: this.#scrub(shown).slice(0, LOCAL_ID_KEPT),
      });
    } catch {
      // observe, never gate
    }
  }

  #noteWriteRateLimited(tool: WriteTool): void {
    try {
      opsLog("kleros_write_rate_limited", { deployment: this.deployment, tool });
    } catch {
      // observe, never gate
    }
  }

  /** Error text from below the service (the network stack) is ours to keep the key out of. */
  #scrub(text: string): string {
    return this.#apiKey === "" ? text : text.split(this.#apiKey).join("[key]");
  }
}

/**
 * The JSON-RPC message of a 200 body. The documented answer is one SSE frame; the Streamable HTTP
 * transport the service runs on may also answer `application/json` (one bare object) or send a
 * notification frame before the response. So: among the `data:` lines, the response (a `result`
 * or an `error` member), the one whose `id` is `id` first; else the first `data:` line,
 * JSON-parsed; with no `data:` line at all, the body itself when it is a JSON object. Anything
 * else is a `KlerosTransportError`.
 */
export function parseSseFrame(body: string, id?: number): unknown {
  const lines = body
    .split(/\r\n|\r|\n/)
    .filter((l) => l.startsWith("data:"))
    .map((l) => l.slice("data:".length));
  if (lines.length === 0) {
    const whole = objectOrNull(body);
    if (whole) return whole;
    throw new KlerosTransportError("the answer carries no SSE data: line");
  }
  const responses = lines
    .map(objectOrNull)
    .filter((v): v is Payload => v !== null && ("result" in v || "error" in v));
  const response = responses.find((v) => id !== undefined && v.id === id) ?? responses[0];
  if (response) return response;
  try {
    return JSON.parse(lines[0]!);
  } catch {
    throw new KlerosTransportError("the SSE data: line is not JSON");
  }
}

/** The `result` of the JSON-RPC response in a 200 body, or a transport error saying why not. */
function resultOf(text: string, id: number, label: string): Payload {
  let frame: unknown;
  try {
    frame = parseSseFrame(text, id);
  } catch (e) {
    throw new KlerosTransportError(`Kleros ${label}: ${(e as Error).message}`);
  }
  if (!isRecord(frame)) {
    throw new KlerosTransportError(`Kleros ${label} answered a frame that is not JSON-RPC`);
  }
  if (frame.error !== undefined && frame.error !== null) {
    const err = isRecord(frame.error) ? frame.error : {};
    throw new KlerosTransportError(
      `Kleros ${label} answered JSON-RPC error ${String(err.code)}: ${String(err.message)}`,
    );
  }
  if (!isRecord(frame.result)) {
    throw new KlerosTransportError(`Kleros ${label} answered no result`);
  }
  return frame.result;
}

/**
 * The LAST JSON object in a tool's text. Every status is bare JSON except `unknown`, which comes
 * after a plain-English warning, so `JSON.parse` on the whole text throws there; the docs say to
 * parse the last object instead. For the last closing brace, the first opening brace that parses
 * up to it is the outermost object, nested objects included.
 */
export function parseToolPayload(text: string): unknown {
  const whole = objectOrNull(text);
  if (whole) return whole;
  const opens = indicesOf(text, "{");
  const closes = indicesOf(text, "}").reverse();
  for (const end of closes) {
    for (const start of opens) {
      if (start >= end) break;
      const found = objectOrNull(text.slice(start, end + 1));
      if (found) return found;
    }
  }
  throw new KlerosTransportError("the tool result carries no JSON object");
}

/**
 * "1", "0x01", 1 and 1n are the same ruling value; a value that does not parse returns null.
 * The service sends `ruling` as a decimal string while a template writes answers as hex ids.
 */
export function normaliseRulingValue(v: unknown): bigint | null {
  if (typeof v === "bigint") return v >= 0n ? v : null;
  if (typeof v === "number") return Number.isSafeInteger(v) && v >= 0 ? BigInt(v) : null;
  if (typeof v !== "string") return null;
  const s = v.trim();
  return /^[0-9]+$/.test(s) || /^0x[0-9a-fA-F]+$/.test(s) ? BigInt(s) : null;
}

/**
 * What a pin retries: a transport error (a deadline included), an HTTP status other than 401,
 * 413 and 429, or a refusal the docs leave "in doubt" (`sentOf` answers "maybe": the same bytes
 * give the same CID, so a repeat publishes nothing new). A "nothing was published" refusal,
 * `PRESET_SIMULATES` included, is final.
 */
function pinMayRetry(e: unknown): boolean {
  if (e instanceof KlerosTransportError) return true;
  if (e instanceof KlerosHttpError) return e.status !== 401 && e.status !== 413 && e.status !== 429;
  if (e instanceof KlerosRefusal) return sentOf("evidence_pin", e.code) === "maybe";
  return false;
}

function pinOutcomeOf(p: Payload): PinOutcome {
  const tool = "evidence_pin";
  if (p.status === "checked") return { status: "checked" };
  if (p.status !== "published") throw noField(tool, "status");
  if (typeof p.fileURI !== "string" || p.fileURI === "") throw noField(tool, "fileURI");
  if (typeof p.cid !== "string" || p.cid === "") throw noField(tool, "cid");
  return { status: "published", fileUri: p.fileURI, cid: p.cid };
}

function createOutcomeOf(
  p: Payload,
  text: string,
  onUnreadableLocalId: (coreDisputeId: string, raw: unknown) => void,
): CreateOutcome {
  const tool = "dispute_create";
  if (p.status !== "mined") return chainWriteOutcomeOf(p, text, tool);
  const coreDisputeId = decimalIdOf(p.coreDisputeID);
  if (coreDisputeId === null) throw noField(tool, "coreDisputeID");
  const txHash = txHashOf(p.txHash);
  if (txHash === null) throw noField(tool, "txHash");
  // localDisputeIDUnavailable stands in when the receipt could not be read back: never a guess.
  if ("localDisputeIDUnavailable" in p || p.localDisputeID === undefined) {
    return { status: "mined", coreDisputeId, txHash };
  }
  const local = decimalIdOf(p.localDisputeID);
  if (local === null) {
    onUnreadableLocalId(coreDisputeId, p.localDisputeID);
    return { status: "mined", coreDisputeId, txHash };
  }
  return { status: "mined", coreDisputeId, localDisputeId: local, txHash };
}

function submitOutcomeOf(p: Payload, text: string): SubmitOutcome {
  const tool = "evidence_submit";
  if (p.status !== "mined") return chainWriteOutcomeOf(p, text, tool);
  const txHash = txHashOf(p.txHash);
  if (txHash === null) throw noField(tool, "txHash");
  return { status: "mined", txHash };
}

/**
 * `unknown` (broadcast, no receipt in time) keeps the service's whole text, every content entry,
 * for the human it goes to.
 * `simulated` sent nothing, but neither key is meant to simulate: it is raised as a refusal so
 * no caller can record it as a filing.
 */
function chainWriteOutcomeOf(
  p: Payload,
  text: string,
  tool: WriteTool,
): { status: "unknown"; txHash?: Hex; text: string } {
  if (p.status === "simulated") throw new KlerosRefusal(tool, SIMULATED);
  if (p.status !== "unknown") throw noField(tool, "status");
  const txHash = txHashOf(p.txHash);
  return txHash === null ? { status: "unknown", text } : { status: "unknown", txHash, text };
}

/**
 * court_get's payload shape is not documented: the court is read at the top level or as
 * `items[0]`; contract values often travel as strings. The court id is the one asked for.
 */
function courtClockOf(payload: Payload, courtId: number): CourtClock {
  const tool = "court_get";
  const court = Array.isArray(payload.items) ? payload.items[0] : payload;
  if (!isRecord(court)) throw noField(tool, "items[0]");
  const t = court.timesPerPeriod;
  const times = Array.isArray(t) && t.length === 4 ? t.map(countOf) : [];
  const [evidence, commit, vote, appeal] = times;
  if (evidence == null || commit == null || vote == null || appeal == null) {
    throw noField(tool, "timesPerPeriod");
  }
  if (typeof court.hiddenVotes !== "boolean") throw noField(tool, "hiddenVotes");
  return {
    courtId,
    timesPerPeriod: [evidence, commit, vote, appeal],
    hiddenVotes: court.hiddenVotes,
    raw: court,
  };
}

/**
 * dispute_get answers a paged envelope: the dispute is `items[0]`. Testnet reads are often
 * partial, so only the fields a ruling cannot be read without are required; `rulingOptions` may
 * be missing only when `unresolvedFields` names it, and is then empty (a mismatch downstream, so
 * nothing acts on it).
 */
function disputeReadOf(payload: Payload, chain: KlerosChain, coreDisputeId: string): DisputeRead {
  const tool = "dispute_get";
  if (!Array.isArray(payload.items)) throw noField(tool, "items");
  if (payload.items.length === 0) {
    throw new KlerosTransportError(`Kleros ${tool}: dispute not found on ${chain}`);
  }
  const item = payload.items[0];
  if (!isRecord(item)) throw noField(tool, "items[0]");
  // The case a ruling is read from must be the one asked: never settle on someone else's case.
  const id = item.id === undefined || item.id === null ? undefined : String(item.id);
  const on = item.chain === undefined || item.chain === null ? undefined : String(item.chain);
  if ((id !== undefined && id !== coreDisputeId) || (on !== undefined && on !== chain)) {
    throw new KlerosTransportError(
      `Kleros ${tool} answered dispute ${id ?? "(no id)"} on ${on ?? "(no chain)"}, ` +
        `not dispute ${coreDisputeId} on ${chain}`,
    );
  }
  const status = item.status;
  if (typeof status !== "string" || !PERIODS.includes(status)) throw noField(tool, "status");
  const ruling =
    typeof item.ruling === "string"
      ? item.ruling
      : typeof item.ruling === "number" && Number.isFinite(item.ruling)
        ? String(item.ruling)
        : null;
  if (ruling === null) throw noField(tool, "ruling");
  if (typeof item.tied !== "boolean") throw noField(tool, "tied");
  if (typeof item.ruled !== "boolean") throw noField(tool, "ruled");
  const roundCount = countOf(item.roundCount);
  if (roundCount === null) throw noField(tool, "roundCount");
  // [] only when the field is absent: a present null is not an empty list.
  const unresolvedFields = item.unresolvedFields === undefined ? [] : item.unresolvedFields;
  if (!Array.isArray(unresolvedFields) || !unresolvedFields.every((f) => typeof f === "string")) {
    throw noField(tool, "unresolvedFields");
  }
  let rulingOptions: { value: string; title: string }[] = [];
  if (item.rulingOptions !== undefined || !unresolvedFields.includes("rulingOptions")) {
    if (!Array.isArray(item.rulingOptions)) throw noField(tool, "rulingOptions");
    rulingOptions = item.rulingOptions.map((o) => {
      const option = optionOf(o);
      if (option === null) throw noField(tool, "rulingOptions");
      return option;
    });
  }
  const read: DisputeRead = {
    status: status as DisputeRead["status"],
    ruling,
    tied: item.tied,
    ruled: item.ruled,
    roundCount,
    rulingOptions,
    deadline: deadlineOf(item.deadline, tool),
    unresolvedFields,
    raw: item,
  };
  if (typeof item.rulingLabel === "string") read.rulingLabel = item.rulingLabel;
  if (typeof item.lastPeriodChange === "string") read.lastPeriodChange = item.lastPeriodChange;
  return read;
}

/** An option's value (`value`, else `id`, else `ruling`) and title (`title`, else `label`). */
function optionOf(o: unknown): { value: string; title: string } | null {
  if (!isRecord(o)) return null;
  const v = o.value ?? o.id ?? o.ruling;
  const value =
    typeof v === "string" ? v : typeof v === "number" && Number.isFinite(v) ? String(v) : null;
  const title =
    typeof o.title === "string" ? o.title : typeof o.label === "string" ? o.label : null;
  return value === null || title === null ? null : { value, title };
}

/** The docs: `null` when the value is absent, and `1970-01-01` is an unset value, never a date. */
function deadlineOf(v: unknown, tool: string): string | null {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v !== "string") throw noField(tool, "deadline");
  return v.startsWith("1970-01-01") ? null : v;
}

function toolsPageOf(result: Payload): { tools: string[]; next: string | undefined } {
  if (!Array.isArray(result.tools)) throw noField("tools/list", "tools");
  const tools = result.tools.map((t) => {
    if (!isRecord(t) || typeof t.name !== "string") throw noField("tools/list", "tools[].name");
    return t.name;
  });
  // Echoed back exactly as received.
  const next =
    typeof result.nextCursor === "string" && result.nextCursor !== ""
      ? result.nextCursor
      : undefined;
  return { tools, next };
}

/** A non-negative integer the service may send as a number or as a string of digits. */
function countOf(v: unknown): number | null {
  if (typeof v === "number") return Number.isSafeInteger(v) && v >= 0 ? v : null;
  if (typeof v !== "string" || !/^[0-9]+$/.test(v)) return null;
  const n = Number(v);
  return Number.isSafeInteger(n) ? n : null;
}

/** A dispute id: digits only, the way the Court interface shows it. */
function decimalIdOf(v: unknown): string | null {
  if (typeof v === "string") return /^[0-9]+$/.test(v) ? v : null;
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? String(v) : null;
}

function txHashOf(v: unknown): Hex | null {
  return typeof v === "string" && /^0x[0-9a-fA-F]{64}$/.test(v) ? (v as Hex) : null;
}

function noField(tool: string, field: string): KlerosTransportError {
  return new KlerosTransportError(`Kleros ${tool} answered without a usable ${field}`);
}

function isRecord(v: unknown): v is Payload {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function objectOrNull(text: string): Payload | null {
  try {
    const v: unknown = JSON.parse(text);
    return isRecord(v) ? v : null;
  } catch {
    return null;
  }
}

function indicesOf(text: string, ch: string): number[] {
  const out: number[] = [];
  for (let i = text.indexOf(ch); i !== -1; i = text.indexOf(ch, i + 1)) out.push(i);
  return out;
}

function errorText(e: unknown): string {
  if (!(e instanceof Error)) return String(e);
  const cause = e.cause instanceof Error ? ` (${e.cause.message})` : "";
  return `${e.name}: ${e.message}${cause}`;
}

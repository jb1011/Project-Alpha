"use client";

import * as React from "react";
import {
  AgentConfig,
  AllowlistEntry,
  ConfigMode,
  formatUsdc,
  isAddress,
  isConfigValid,
  shortAddress,
  validateConfig,
} from "../types";
import { StepNav } from "../OnboardingFlow";
import {
  Button,
  Callout,
  Card,
  CheckIcon,
  DotIcon,
  Field,
  StepHeader,
  TextInput,
  Textarea,
  cx,
} from "../primitives";

type Props = {
  config: AgentConfig;
  onChange: (next: AgentConfig) => void;
  onBack: () => void;
  onComplete: () => void;
};

const SAMPLE_PROPOSAL: Partial<AgentConfig> = {
  name: "Atlas Treasury Bot",
  purpose:
    "Pays recurring infra invoices and rebalances the operating float across approved vendors. Read-only on everything else.",
  perTxCap: "500",
  dailyCap: "2500",
  timelockHours: "12",
  allowlist: [
    { id: "s1", label: "Infra · Render", address: "0x4f2a9c1b7e5d3a8f0c6b2d4e1a9f7c3b5d8e0a2c" },
    { id: "s2", label: "Counsel · escrow", address: "0x9b1d7e3c5a2f8d4b6c0e1a3f9d7b5c2e4a6f8b0d" },
  ],
};

let allowlistSeq = 0;
function newAllowlistEntry(): AllowlistEntry {
  allowlistSeq += 1;
  const id =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `al-${Date.now()}-${allowlistSeq}`;
  return { id, label: "", address: "" };
}

export function ConfigureStep({ config, onChange, onBack, onComplete }: Props) {
  const errors = validateConfig(config);
  const valid = isConfigValid(config);

  function setMode(mode: ConfigMode) {
    onChange({ ...config, configMode: mode });
  }

  function set<K extends keyof AgentConfig>(key: K, value: AgentConfig[K]) {
    onChange({ ...config, [key]: value });
  }

  // Mode B is "connected" once the agent has produced a proposal (has a name).
  const mcpConnected = config.configMode === "mcp" && config.name.trim().length > 0;

  return (
    <div>
      <StepHeader
        eyebrow="Screen 01"
        title="Define your agent"
        intro="Set the identity and the rules — spending caps, allowed recipients, and timelocks. The result is a policy your agent can never exceed on its own."
      />

      <ModeToggle mode={config.configMode} onSet={setMode} />

      <div className="mt-8 grid grid-cols-1 gap-8 lg:grid-cols-[1fr_330px] lg:gap-10">
        <div className="min-w-0">
          {config.configMode === "manual" ? (
            <ManualForm
              config={config}
              errors={errors}
              set={set}
              onChange={onChange}
            />
          ) : (
            <McpReview
              config={config}
              connected={mcpConnected}
              onPropose={() =>
                onChange({ ...config, ...SAMPLE_PROPOSAL, configMode: "mcp" })
              }
              onEditManually={() => setMode("manual")}
            />
          )}
        </div>

        <div className="lg:sticky lg:top-24 lg:self-start">
          <PolicyPreview config={config} valid={valid} />
        </div>
      </div>

      <StepNav onBack={onBack}>
        <span className="text-[12px] text-muted-2">
          {valid ? "Rules are valid" : "Complete the rules to continue"}
        </span>
        <Button onClick={onComplete} disabled={!valid}>
          Review agreement
          <CheckIcon className="h-4 w-4" />
        </Button>
      </StepNav>
    </div>
  );
}

/* ------------------------------------------------------------------ */

function ModeToggle({
  mode,
  onSet,
}: {
  mode: ConfigMode;
  onSet: (m: ConfigMode) => void;
}) {
  const options: { id: ConfigMode; label: string; sub: string }[] = [
    { id: "manual", label: "Manual form", sub: "Fill the rules yourself" },
    { id: "mcp", label: "Agent self-config", sub: "Your AI agent drafts it via MCP" },
  ];
  return (
    <div className="inline-flex w-full max-w-md gap-1 rounded-2xl border hairline bg-paper-2/50 p-1 sm:w-auto">
      {options.map((o) => {
        const active = mode === o.id;
        return (
          <button
            key={o.id}
            onClick={() => onSet(o.id)}
            className={cx(
              "flex flex-1 flex-col items-start gap-0.5 rounded-xl px-4 py-2.5 text-left transition-colors sm:flex-none sm:min-w-[180px]",
              active ? "bg-ink text-paper" : "text-muted hover:bg-paper-2 hover:text-ink",
            )}
          >
            <span className="text-[13px] font-medium">{o.label}</span>
            <span className={cx("text-[11px]", active ? "text-paper/70" : "text-muted-2")}>
              {o.sub}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ */

function ManualForm({
  config,
  errors,
  set,
  onChange,
}: {
  config: AgentConfig;
  errors: ReturnType<typeof validateConfig>;
  set: <K extends keyof AgentConfig>(key: K, value: AgentConfig[K]) => void;
  onChange: (next: AgentConfig) => void;
}) {
  function updateAllowlist(next: AllowlistEntry[]) {
    onChange({ ...config, allowlist: next });
  }

  return (
    <div className="flex flex-col gap-6">
      <Card className="p-6">
        <SectionTitle n="A" title="Identity" />
        <div className="mt-5 flex flex-col gap-5">
          <Field label="Agent name" htmlFor="agent-name" error={errors.name}>
            <TextInput
              id="agent-name"
              placeholder="e.g. Atlas Treasury Bot"
              value={config.name}
              invalid={!!errors.name}
              onChange={(e) => set("name", e.target.value)}
            />
          </Field>
          <Field
            label="Purpose"
            htmlFor="agent-purpose"
            hint="Plain language — what is this agent for?"
          >
            <Textarea
              id="agent-purpose"
              rows={3}
              placeholder="Describe what the agent should do…"
              value={config.purpose}
              onChange={(e) => set("purpose", e.target.value)}
            />
          </Field>
        </div>
      </Card>

      <Card className="p-6">
        <SectionTitle n="B" title="Spending limits" />
        <div className="mt-5 grid grid-cols-1 gap-5 sm:grid-cols-2">
          <Field
            label="Per-transaction cap"
            htmlFor="pertx"
            hint="USDC"
            error={errors.perTxCap}
          >
            <UsdcInput
              id="pertx"
              value={config.perTxCap}
              invalid={!!errors.perTxCap}
              onChange={(v) => set("perTxCap", v)}
            />
          </Field>
          <Field
            label="Daily cap"
            htmlFor="daily"
            hint="USDC / rolling 24h"
            error={errors.dailyCap}
          >
            <UsdcInput
              id="daily"
              value={config.dailyCap}
              invalid={!!errors.dailyCap}
              onChange={(v) => set("dailyCap", v)}
            />
          </Field>
          <Field
            label="Timelock"
            htmlFor="timelock"
            hint="Hours before sensitive actions execute"
            error={errors.timelockHours}
            className="sm:col-span-2"
          >
            <TextInput
              id="timelock"
              type="number"
              min={0}
              className="max-w-[160px]"
              value={config.timelockHours}
              invalid={!!errors.timelockHours}
              onChange={(e) => set("timelockHours", e.target.value)}
            />
          </Field>
        </div>
      </Card>

      <Card className="p-6">
        <div className="flex items-center justify-between">
          <SectionTitle n="C" title="Allowed recipients" />
          <Button
            variant="ghost"
            size="md"
            onClick={() => updateAllowlist([...config.allowlist, newAllowlistEntry()])}
          >
            + Add address
          </Button>
        </div>
        <p className="mt-3 text-[12px] leading-[1.5] text-muted-2">
          If you add addresses, the agent can only send funds to this allowlist.
          Leave empty to allow any recipient within the spending caps.
        </p>

        {config.allowlist.length > 0 && (
          <div className="mt-5 flex flex-col gap-3">
            {config.allowlist.map((entry) => {
              const badAddr = entry.address.length > 0 && !isAddress(entry.address);
              return (
                <div
                  key={entry.id}
                  className="grid grid-cols-1 gap-2 rounded-xl border hairline bg-paper/50 p-3 sm:grid-cols-[160px_1fr_auto]"
                >
                  <TextInput
                    placeholder="Label"
                    value={entry.label}
                    onChange={(e) =>
                      updateAllowlist(
                        config.allowlist.map((x) =>
                          x.id === entry.id ? { ...x, label: e.target.value } : x,
                        ),
                      )
                    }
                  />
                  <TextInput
                    placeholder="0x…"
                    spellCheck={false}
                    value={entry.address}
                    invalid={badAddr}
                    onChange={(e) =>
                      updateAllowlist(
                        config.allowlist.map((x) =>
                          x.id === entry.id ? { ...x, address: e.target.value } : x,
                        ),
                      )
                    }
                  />
                  <button
                    onClick={() =>
                      updateAllowlist(config.allowlist.filter((x) => x.id !== entry.id))
                    }
                    className="rounded-xl border hairline-strong px-3 text-[12px] text-muted transition-colors hover:bg-paper-2 hover:text-[#ff8a84]"
                    aria-label="Remove address"
                  >
                    Remove
                  </button>
                </div>
              );
            })}
          </div>
        )}
        {errors.allowlistRow && (
          <p className="mt-3 flex items-center gap-1.5 text-[11.5px] text-[#ff8a84]">
            <DotIcon className="h-1.5 w-1.5" /> {errors.allowlistRow}
          </p>
        )}
      </Card>

      <Callout tone="info" title="You are the guardian">
        Your account is recorded as the human guardian on every rule above. You
        keep the power to pause, veto, or recover funds at any time.
      </Callout>
    </div>
  );
}

function UsdcInput({
  id,
  value,
  invalid,
  onChange,
}: {
  id?: string;
  value: string;
  invalid?: boolean;
  onChange: (v: string) => void;
}) {
  return (
    <div className="relative">
      <TextInput
        id={id}
        type="number"
        min={0}
        inputMode="decimal"
        className="pr-14 pl-3.5"
        placeholder="0.00"
        value={value}
        invalid={invalid}
        onChange={(e) => onChange(e.target.value)}
      />
      <span className="pointer-events-none absolute right-3.5 top-1/2 -translate-y-1/2 text-[11.5px] text-muted-2">
        USDC
      </span>
    </div>
  );
}

/* ------------------------------------------------------------------ */

function McpReview({
  config,
  connected,
  onPropose,
  onEditManually,
}: {
  config: AgentConfig;
  connected: boolean;
  onPropose: () => void;
  onEditManually: () => void;
}) {
  if (!connected) {
    return (
      <Card className="p-6">
        <SectionTitle n="B" title="Connect your agent" />
        <p className="mt-3 max-w-lg text-[13px] leading-[1.6] text-muted">
          Point your AI agent at our MCP server. It will draft its own policy in
          conversation — and our server validates every rule in real time, so an
          invalid proposal is corrected on the spot.
        </p>

        <div className="mt-5 rounded-xl border hairline bg-paper px-4 py-3 font-mono text-[12px] text-muted">
          <div className="flex items-center justify-between">
            <span className="text-muted-2">MCP endpoint</span>
            <span className="text-accent-soft">connected · live validation</span>
          </div>
          <div className="mt-1.5 text-ink">
            https://mcp.novicorpus.xyz/agent-policy
          </div>
        </div>

        <div className="mt-6 flex flex-wrap items-center gap-3">
          <Button onClick={onPropose}>Simulate agent proposal</Button>
          <button
            onClick={onEditManually}
            className="text-[12.5px] text-muted underline-offset-2 hover:text-ink hover:underline"
          >
            Or fill it manually
          </button>
        </div>

        <Callout tone="warn" className="mt-6" title="The human still approves">
          Even in self-config mode, you must approve the final policy before it
          goes on-chain — you are the legally responsible guardian.
        </Callout>
      </Card>
    );
  }

  return (
    <Card className="p-6">
      <div className="flex items-center justify-between">
        <SectionTitle n="B" title="Your agent's proposal" />
        <span className="inline-flex items-center gap-1.5 rounded-full border border-accent/30 bg-accent/10 px-2.5 py-1 text-[11px] text-accent-soft">
          <CheckIcon className="h-3 w-3" /> Schema-valid
        </span>
      </div>

      <p className="mt-3 text-[13px] leading-[1.6] text-muted">
        Here are the rules your agent defined. Review them in plain language —
        approve as-is, or switch to the form to adjust anything.
      </p>

      <div className="mt-5 flex flex-col gap-3">
        <ProposalRow label="Name" value={config.name} />
        <ProposalRow label="Purpose" value={config.purpose} />
        <ProposalRow
          label="Per-transaction cap"
          value={`${formatUsdc(config.perTxCap)} USDC`}
        />
        <ProposalRow label="Daily cap" value={`${formatUsdc(config.dailyCap)} USDC`} />
        <ProposalRow label="Timelock" value={`${config.timelockHours || "0"} hours`} />
        <ProposalRow
          label="Allowed recipients"
          value={
            config.allowlist.length
              ? config.allowlist.map((a) => a.label || shortAddress(a.address)).join(", ")
              : "Any (within caps)"
          }
        />
      </div>

      <div className="mt-6 flex flex-wrap items-center gap-3">
        <Button variant="ghost" onClick={onEditManually}>
          Edit in form
        </Button>
        <button
          onClick={onPropose}
          className="text-[12.5px] text-muted underline-offset-2 hover:text-ink hover:underline"
        >
          Regenerate proposal
        </button>
      </div>
    </Card>
  );
}

function ProposalRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[130px_1fr] gap-3 border-b hairline pb-3 last:border-0 last:pb-0">
      <span className="text-[12px] text-muted-2">{label}</span>
      <span className="text-[13px] text-ink">{value || "—"}</span>
    </div>
  );
}

/* ------------------------------------------------------------------ */

function PolicyPreview({ config, valid }: { config: AgentConfig; valid: boolean }) {
  const can: string[] = [];
  const cannot: string[] = [];

  const perTx = config.perTxCap ? `${formatUsdc(config.perTxCap)} USDC` : "—";
  const daily = config.dailyCap ? `${formatUsdc(config.dailyCap)} USDC` : "—";

  can.push(`Spend up to ${perTx} per transaction`);
  can.push(`Spend up to ${daily} per day`);
  if (config.allowlist.length) {
    can.push(`Send only to ${config.allowlist.length} approved recipient${config.allowlist.length > 1 ? "s" : ""}`);
  } else {
    can.push("Send to any recipient (within caps)");
  }

  cannot.push(`Exceed ${daily} in a 24h window`);
  cannot.push(
    `Run a sensitive action before a ${config.timelockHours || "0"}h timelock`,
  );
  if (config.allowlist.length) {
    cannot.push("Send to addresses outside the allowlist");
  }
  cannot.push("Move funds without you, the guardian");

  return (
    <Card className="overflow-hidden">
      <div className="border-b hairline px-5 py-4">
        <div className="text-[11px] uppercase tracking-[0.18em] text-muted-2">
          Plain-language summary
        </div>
        <div className="mt-1 text-[14px] font-medium text-ink">
          {config.name.trim() || "Your agent"} will…
        </div>
      </div>

      <div className="px-5 py-4">
        <PreviewGroup tone="ok" heading="Can" items={can} />
        <PreviewGroup tone="no" heading="Cannot" items={cannot} className="mt-4" />
      </div>

      <div className="border-t hairline px-5 py-3 text-[11.5px]">
        {valid ? (
          <span className="flex items-center gap-2 text-accent-soft">
            <CheckIcon className="h-3.5 w-3.5" /> Ready — validated against the policy schema
          </span>
        ) : (
          <span className="text-muted-2">Fill the required rules to validate.</span>
        )}
      </div>
    </Card>
  );
}

function PreviewGroup({
  tone,
  heading,
  items,
  className,
}: {
  tone: "ok" | "no";
  heading: string;
  items: string[];
  className?: string;
}) {
  return (
    <div className={className}>
      <div className="mb-2 text-[11px] uppercase tracking-[0.16em] text-muted-2">
        {heading}
      </div>
      <ul className="flex flex-col gap-2">
        {items.map((item, i) => (
          <li key={i} className="flex items-start gap-2.5 text-[12.5px] leading-[1.45] text-ink/90">
            <span
              className={cx(
                "mt-[3px] flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full",
                tone === "ok"
                  ? "bg-accent/15 text-accent-soft"
                  : "bg-[#ff5f57]/12 text-[#ff8a84]",
              )}
            >
              {tone === "ok" ? (
                <CheckIcon className="h-2.5 w-2.5" />
              ) : (
                <span className="h-[1.5px] w-2 rounded-full bg-current" />
              )}
            </span>
            {item}
          </li>
        ))}
      </ul>
    </div>
  );
}

function SectionTitle({ n, title }: { n: string; title: string }) {
  return (
    <div className="flex items-center gap-2.5">
      <span className="flex h-5 w-5 items-center justify-center rounded-md border hairline-strong bg-paper text-[10.5px] text-muted">
        {n}
      </span>
      <h3 className="text-[14px] font-medium text-ink">{title}</h3>
    </div>
  );
}

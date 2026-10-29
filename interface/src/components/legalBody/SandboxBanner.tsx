"use client";

/**
 * The sandbox said out loud, in amber, on every screen of the flow where a stranger might take a
 * test record for a filing. The lines are `bannerLines`' answer for the deployment; none, nothing.
 */
export function SandboxBanner({ lines }: { lines: string[] }) {
  if (lines.length === 0) return null;
  return (
    <div
      role="note"
      className="mb-8 flex flex-col gap-1 rounded-xl border border-[#febc2e]/30 bg-[#febc2e]/[0.07] px-4 py-3 text-[12.5px] leading-[1.5] text-[#f3cd72]"
    >
      {lines.map((line) => (
        <p key={line}>{line}</p>
      ))}
    </div>
  );
}

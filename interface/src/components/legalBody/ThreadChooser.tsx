"use client";

import { Button, Card, StepHeader } from "@/components/onboarding/primitives";
import { LEGAL_BODY_COPY } from "@/lib/legalBody/copy";
import type { LegalBodyThreadRef } from "@/lib/legalBody/flow";
import type { ChooserRow } from "@/lib/legalBody/resume";

const C = LEGAL_BODY_COPY.chooser;

/**
 * Several companies or orders in progress and none remembered: the person picks one. The rows are
 * `chooserRows`' answer; a pick is remembered by the flow, and the others stay as they are.
 */
export function ThreadChooser({
  rows,
  onChoose,
}: {
  rows: ChooserRow[];
  onChoose: (ref: LegalBodyThreadRef) => void;
}) {
  return (
    <div>
      <StepHeader eyebrow={LEGAL_BODY_COPY.rail.labels.company} title={C.title} intro={C.intro} />
      <ul className="flex flex-col gap-4">
        {rows.map((row) => (
          <li key={row.key}>
            <Card className="flex flex-wrap items-center justify-between gap-4 p-5">
              <div className="min-w-0">
                <div className="text-[14px] font-medium text-ink">{row.title}</div>
                <div className="mt-1 text-[12.5px] text-muted">{row.detail}</div>
                {row.identity && (
                  <div className="mt-1 font-mono text-[12px] text-muted-2">{row.identity}</div>
                )}
              </div>
              <Button variant="subtle" onClick={() => onChoose(row.ref)}>
                {C.continue}
              </Button>
            </Card>
          </li>
        ))}
      </ul>
    </div>
  );
}

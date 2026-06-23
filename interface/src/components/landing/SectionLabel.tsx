type Props = {
  index?: string;
  label: string;
  tone?: "ink" | "paper";
  className?: string;
};

export function SectionLabel({ index, label, tone = "ink", className = "" }: Props) {
  const isInk = tone === "ink";
  return (
    <div
      className={`inline-flex items-center gap-2 text-[11.5px] uppercase tracking-[0.22em] ${
        isInk ? "text-muted-2" : "text-muted-dark"
      } ${className}`}
    >
      {index && (
        <>
          <span className={`font-mono ${isInk ? "text-muted" : "text-ink/70"}`}>
            {index}
          </span>
          <span
            className={`inline-block h-px w-6 ${
              isInk ? "bg-line-strong" : "bg-line-dark-strong"
            }`}
          />
        </>
      )}
      <span>{label}</span>
    </div>
  );
}

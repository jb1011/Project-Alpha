type Props = {
  className?: string;
  tone?: "ink" | "paper";
};

/** Shared mark — matches app/icon.svg: rounded square, cream serif N, no accent dot. */
function Mark({ tone = "ink" }: { tone?: "ink" | "paper" }) {
  const ink = tone === "ink";
  return (
    <span
      className={`inline-flex h-7 w-7 items-center justify-center rounded-[5px] border ${
        ink
          ? "border-line-strong bg-paper-2 text-[#EDE8DE]"
          : "border-line-dark-strong bg-ink-3 text-[#EDE8DE]"
      }`}
    >
      <span
        className="text-[18px] leading-none -mt-0.5"
        style={{ fontFamily: "Georgia, 'Times New Roman', Times, serif" }}
      >
        N
      </span>
    </span>
  );
}

export function Wordmark({ className = "", tone = "ink" }: Props) {
  const ink = tone === "ink";
  return (
    <a
      href="/"
      className={`group inline-flex items-center gap-2.5 ${className}`}
      aria-label="Novi Corpus home"
    >
      <Mark tone={tone} />
      <span className="flex flex-col gap-1">
        <span
          className={`text-[15px] font-medium leading-tight tracking-tight ${
            ink ? "text-ink" : "text-ink"
          }`}
        >
          Novi Corpus
        </span>
      </span>
    </a>
  );
}

export { Mark };

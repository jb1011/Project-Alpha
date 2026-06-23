type Props = {
  className?: string;
  tone?: "ink" | "paper";
};

export function Wordmark({ className = "", tone = "ink" }: Props) {
  const ink = tone === "ink";
  return (
    <a
      href="#top"
      className={`group inline-flex items-center gap-2.5 ${className}`}
      aria-label="projectAlpha home"
    >
      <span
        className={`relative inline-flex h-7 w-7 items-center justify-center rounded-md border ${
          ink
            ? "border-line-strong bg-paper-2 text-ink"
            : "border-line-dark-strong bg-ink-3 text-ink"
        }`}
      >
        <span className="font-serif text-[18px] leading-none -mt-0.5">α</span>
        <span
          aria-hidden
          className={`absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full ${
            ink ? "bg-accent" : "bg-highlight"
          }`}
        />
      </span>
      <span className="flex flex-col leading-none">
        <span
          className={`text-[15px] font-medium tracking-tight ${
            ink ? "text-ink" : "text-ink"
          }`}
        >
          ProjectAlpha
        </span>
        <span
          className={`text-[10px] uppercase tracking-[0.18em] ${
            ink ? "text-muted-2" : "text-muted-dark-2"
          }`}
        >
          autonomous entities
        </span>
      </span>
    </a>
  );
}

type Line =
  | { kind: "prompt"; user?: string; host?: string; cmd: string; delay?: number }
  | { kind: "out"; text: string; tone?: "muted" | "ok" | "info" | "warn"; delay?: number }
  | { kind: "blank"; delay?: number };

type Props = {
  title?: string;
  lines: Line[];
  cursor?: boolean;
  className?: string;
};

const toneClasses: Record<NonNullable<Extract<Line, { kind: "out" }>["tone"]>, string> = {
  muted: "text-muted-dark-2",
  ok: "text-accent-soft",
  info: "text-[#9bc4ff]",
  warn: "text-highlight",
};

export function Terminal({
  title = "projectAlpha — console",
  lines,
  cursor = true,
  className = "",
}: Props) {
  return (
    <div
      className={`relative overflow-hidden rounded-2xl border hairline-dark bg-ink-2/95 shadow-[0_30px_80px_-30px_rgba(0,0,0,0.55)] ${className}`}
    >
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-[0.55]"
        style={{
          backgroundImage:
            "radial-gradient(circle at 80% 0%, rgba(31,110,63,0.18) 0%, transparent 55%), radial-gradient(circle at 0% 100%, rgba(244,212,115,0.08) 0%, transparent 55%)",
        }}
      />

      <div className="relative flex items-center justify-between border-b hairline-dark px-4 py-2.5">
        <div className="flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full bg-[#ff5f57]" />
          <span className="h-2.5 w-2.5 rounded-full bg-[#febc2e]" />
          <span className="h-2.5 w-2.5 rounded-full bg-[#28c840]" />
        </div>
        <span className="font-mono text-[11px] tracking-wide text-muted-dark-2">
          {title}
        </span>
        <span className="font-mono text-[11px] text-muted-dark-2">
          zsh · main
        </span>
      </div>

      <div className="relative px-5 py-5 font-mono text-[12.5px] leading-[1.65]">
        {lines.map((line, i) => {
          const delay = line.delay ?? i * 0.18;
          const style = { animationDelay: `${delay}s` } as React.CSSProperties;

          if (line.kind === "blank") {
            return <div key={i} className="h-3" />;
          }

          if (line.kind === "prompt") {
            const user = line.user ?? "agent";
            const host = line.host ?? "alpha";
            return (
              <div key={i} className="anim-line whitespace-pre" style={style}>
                <span className="text-accent-soft">{user}</span>
                <span className="text-muted-dark-2">@</span>
                <span className="text-[#9bc4ff]">{host}</span>
                <span className="text-muted-dark-2"> ~ </span>
                <span className="text-highlight">$</span>{" "}
                <span className="text-ink">{line.cmd}</span>
              </div>
            );
          }

          const tone = line.tone ?? "muted";
          return (
            <div
              key={i}
              className={`anim-line whitespace-pre ${toneClasses[tone]}`}
              style={style}
            >
              {line.text}
            </div>
          );
        })}

        {cursor && (
          <div
            className="anim-line flex items-center gap-2 pt-0.5"
            style={{ animationDelay: `${lines.length * 0.18 + 0.05}s` }}
          >
            <span className="text-highlight">$</span>
            <span className="inline-block h-3.5 w-2 bg-ink anim-cursor" />
          </div>
        )}
      </div>
    </div>
  );
}

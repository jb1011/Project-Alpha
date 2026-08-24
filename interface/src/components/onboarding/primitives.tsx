import { forwardRef, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes } from "react";

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

/* ------------------------------------------------------------------ */
/* Buttons                                                             */
/* ------------------------------------------------------------------ */

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "ghost" | "danger" | "subtle";
  size?: "md" | "lg";
  loading?: boolean;
};

export function Button({
  variant = "primary",
  size = "md",
  loading = false,
  className,
  children,
  disabled,
  ...rest
}: ButtonProps) {
  const base =
    "cursor-pointer group inline-flex items-center justify-center gap-2 rounded-full font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 focus-visible:ring-offset-2 focus-visible:ring-offset-paper";
  const sizes = {
    md: "px-5 py-2.5 text-[13.5px]",
    lg: "px-6 py-3.5 text-[14.5px]",
  } as const;
  const variants = {
    primary: "bg-ink text-paper hover:bg-ink-hover",
    ghost: "border hairline-strong bg-paper/40 text-ink hover:bg-paper-2",
    subtle: "text-muted hover:text-ink hover:bg-paper-2",
    danger:
      "border border-[#ff5f57]/40 bg-[#ff5f57]/10 text-[#ff8a84] hover:bg-[#ff5f57]/16",
  } as const;

  return (
    <button
      className={cx(base, sizes[size], variants[variant], className)}
      disabled={disabled || loading}
      {...rest}
    >
      {loading && <Spinner className="h-3.5 w-3.5" />}
      {children}
    </button>
  );
}

export function Spinner({ className }: { className?: string }) {
  return (
    <span
      className={cx(
        "inline-block animate-spin rounded-full border-[1.5px] border-current border-r-transparent align-[-2px]",
        className ?? "h-4 w-4",
      )}
      aria-hidden
    />
  );
}

/* ------------------------------------------------------------------ */
/* Form fields                                                         */
/* ------------------------------------------------------------------ */

export function Field({
  label,
  hint,
  error,
  htmlFor,
  children,
  className,
}: {
  label: string;
  hint?: string;
  error?: string;
  htmlFor?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cx("flex flex-col gap-1.5", className)}>
      <div className="flex items-baseline justify-between gap-3">
        <label
          htmlFor={htmlFor}
          className="text-[12.5px] font-medium text-ink"
        >
          {label}
        </label>
        {hint && !error && (
          <span className="text-[11px] text-muted-2">{hint}</span>
        )}
      </div>
      {children}
      {error && (
        <span className="flex items-center gap-1.5 text-[11.5px] text-[#ff8a84]">
          <DotIcon className="h-1.5 w-1.5" /> {error}
        </span>
      )}
    </div>
  );
}

const inputBase =
  "w-full rounded-xl border bg-paper-2/80 px-3.5 py-2.5 text-[13.5px] text-ink placeholder:text-muted-2 transition-colors focus:outline-none focus:ring-2 focus:ring-accent/45";

export const TextInput = forwardRef<
  HTMLInputElement,
  InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }
>(function TextInput({ className, invalid, ...rest }, ref) {
  return (
    <input
      ref={ref}
      className={cx(
        inputBase,
        invalid ? "border-[#ff5f57]/45" : "hairline-strong",
        className,
      )}
      {...rest}
    />
  );
});

export const Textarea = forwardRef<
  HTMLTextAreaElement,
  TextareaHTMLAttributes<HTMLTextAreaElement> & { invalid?: boolean }
>(function Textarea({ className, invalid, ...rest }, ref) {
  return (
    <textarea
      ref={ref}
      className={cx(
        inputBase,
        "resize-none leading-[1.55]",
        invalid ? "border-[#ff5f57]/45" : "hairline-strong",
        className,
      )}
      {...rest}
    />
  );
});

/* ------------------------------------------------------------------ */
/* Callout — used heavily for the non-custodial messaging             */
/* ------------------------------------------------------------------ */

export function Callout({
  tone = "accent",
  icon,
  title,
  children,
  className,
}: {
  tone?: "accent" | "info" | "warn" | "alarm" | "muted";
  icon?: ReactNode;
  title?: string;
  children?: ReactNode;
  className?: string;
}) {
  const tones = {
    accent: "border-accent/25 bg-accent/[0.07] text-accent-soft",
    info: "border-line-strong bg-paper-2/70 text-muted",
    // `muted` is `info` under the vocabulary the chain-reading cards speak (alarm / warn / muted),
    // where "info" would read as a fourth severity rather than the absence of one. Same pixels,
    // and deliberately so: one visual language, two names for the quiet end of it.
    muted: "border-line-strong bg-paper-2/70 text-muted",
    warn: "border-[#febc2e]/30 bg-[#febc2e]/[0.07] text-[#f3cd72]",
    // Louder than `warn` on purpose, and reserved for the one thing that earns it: the platform's
    // record disagreeing with the chain. Spending it on anything routine is how a guardian learns
    // to ignore it.
    alarm: "border-[#ff5f57]/45 bg-[#ff5f57]/[0.09] text-[#ff8a84]",
  } as const;
  return (
    <div
      className={cx(
        "flex gap-3 rounded-xl border px-4 py-3 text-[12.5px] leading-[1.5]",
        tones[tone],
        className,
      )}
    >
      {icon && <span className="mt-0.5 shrink-0">{icon}</span>}
      <div className="min-w-0">
        {title && (
          <div className="font-medium text-ink">{title}</div>
        )}
        <div className={cx(title && "mt-0.5")}>{children}</div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* The amber pill — the honesty invariant, as one component            */
/* ------------------------------------------------------------------ */

/**
 * AMBER, never green.
 *
 * A demo formation, a sandbox document set and a pending amendment are all states that are honest
 * but not confirmed, and the guardian-waiver card set the rule they follow: an unconfirmed state
 * gets its OWN colour rather than borrowing the confirmed one. Four surfaces render that pill
 * (the formation card's badge, the wizard's sandbox panel, the dashboard's "update pending" chip
 * and the veto card), and four hand-rolled copies of a colour rule is three copies too many —
 * the one that drifts to `emerald` is the one that lies.
 *
 * `size` is the only axis, because the pill sits in three different type contexts: beside a card
 * heading, inside an `h1`, and as a standalone label.
 */
export function AmberPill({
  size = "md",
  dot = true,
  title,
  className,
  children,
}: {
  size?: "sm" | "md" | "label";
  /** The leading dot. Off where the pill already sits next to one. */
  dot?: boolean;
  title?: string;
  className?: string;
  children: ReactNode;
}) {
  const sizes = {
    sm: "px-2 py-0.5 text-[10.5px]",
    md: "px-3 py-1 text-[11.5px]",
    label: "px-3 py-1 text-[11px] uppercase tracking-[0.14em]",
  } as const;
  return (
    <span
      title={title}
      className={cx(
        "inline-flex items-center gap-1.5 rounded-full border border-[#febc2e]/40 bg-[#febc2e]/10 text-[#f3cd72]",
        sizes[size],
        className,
      )}
    >
      {dot && (
        <span
          aria-hidden
          className={cx(
            "shrink-0 rounded-full bg-[#febc2e]",
            size === "sm" ? "h-1 w-1" : "h-1.5 w-1.5",
          )}
        />
      )}
      {children}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* Section title — one component, both variants                        */
/* ------------------------------------------------------------------ */

/**
 * The small heading above a block, in its two shapes: the plain tracked caps used on every card,
 * and the lettered variant the wizard's long forms use to say "part A", "part B".
 *
 * One component rather than the four private copies this replaces — three of them identical to
 * the character, which is exactly the sort of thing that ends up with four different letter
 * spacings after a year.
 */
export function SectionTitle({
  n,
  className,
  children,
}: {
  /** The letter badge. Present → the lettered form-section variant; absent → the plain caps one. */
  n?: string;
  className?: string;
  children: ReactNode;
}) {
  if (n) {
    return (
      <div className={cx("flex items-center gap-2.5", className)}>
        <span className="flex h-5 w-5 items-center justify-center rounded-md border hairline-strong bg-paper text-[10.5px] text-muted">
          {n}
        </span>
        <h3 className="text-[14px] font-medium text-ink">{children}</h3>
      </div>
    );
  }
  return (
    <div className={cx("text-[11px] uppercase tracking-[0.18em] text-muted-2", className)}>
      {children}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Step header                                                         */
/* ------------------------------------------------------------------ */

export function StepHeader({
  eyebrow,
  title,
  intro,
}: {
  eyebrow: string;
  title: ReactNode;
  intro?: ReactNode;
}) {
  return (
    <header className="mb-8">
      <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.22em] text-muted-2">
        <span className="font-mono text-muted">{eyebrow}</span>
        <span className="inline-block h-px w-6 bg-line-strong" />
      </div>
      <h1 className="mt-3 text-balance text-[30px] font-medium leading-[1.08] tracking-[-0.02em] text-ink sm:text-[38px]">
        {title}
      </h1>
      {intro && (
        <p className="mt-3 max-w-2xl text-pretty text-[14.5px] leading-[1.6] text-muted">
          {intro}
        </p>
      )}
    </header>
  );
}

/* ------------------------------------------------------------------ */
/* Card                                                                */
/* ------------------------------------------------------------------ */

export function Card({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={cx(
        "rounded-2xl border hairline bg-paper-2/50 backdrop-blur-sm",
        className,
      )}
    >
      {children}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Icons (inline, stroke = currentColor)                               */
/* ------------------------------------------------------------------ */

type IconProps = { className?: string };

export function DotIcon({ className }: IconProps) {
  return (
    <span
      className={cx("inline-block rounded-full bg-current", className ?? "h-2 w-2")}
      aria-hidden
    />
  );
}

export function CheckIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden>
      <path
        d="M3.5 8.5l3 3 6-7"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function ArrowIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden>
      <path
        d="M3 8h10M9 4l4 4-4 4"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function FingerprintIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden>
      <path
        d="M12 11v3.5M8.5 9.2A5 5 0 0117 12v1.5M6.6 13.5V12a5.4 5.4 0 011.2-3.4M9 16.8c.3.9.4 1.5.4 2.2M12 13v2c0 1.6.4 2.8 1 4M15.4 12v2.6c0 1.4.3 2.4.9 3.4M4 8.6a9 9 0 0114.6-1.4M20 9.5c.3 1 .4 1.8.4 2.8v1"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function ShieldIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden>
      <path
        d="M12 3l8 3v6c0 5-3.4 8.4-8 10-4.6-1.6-8-5-8-10V6l8-3z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <path
        d="M8.5 12l2.3 2.3L15.5 9.5"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function KeyIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden>
      <circle cx="8" cy="8" r="4" stroke="currentColor" strokeWidth="1.3" />
      <path
        d="M11 11l8 8M16 16l2-2M18.5 18.5l1.8-1.8"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function ExternalIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden>
      <path
        d="M6 3h7v7M13 3L6.5 9.5M11 9.5V13H3V5h3.5"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

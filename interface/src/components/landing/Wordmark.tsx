import Link from "next/link";

type Tone = "ink" | "paper";

type Props = {
  className?: string;
  tone?: Tone;
};

const LOCKUP: Record<Tone, string> = {
  ink: "/logo/novi-corpus-lockup-white.png",
  paper: "/logo/novi-corpus-lockup-black.png",
};

const MARK: Record<Tone, string> = {
  ink: "/logo/novi-corpus-mark-white.png",
  paper: "/logo/novi-corpus-mark-black.png",
};

/** Courthouse mark. `ink` is the light mark for dark surfaces. */
function Mark({ tone = "ink" }: { tone?: Tone }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={MARK[tone]} alt="" className="h-7 w-7 object-contain" />
  );
}

export function Wordmark({ className = "", tone = "ink" }: Props) {
  return (
    <Link
      href="/"
      className={`group inline-flex items-center ${className}`}
      aria-label="Novi Corpus home"
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={LOCKUP[tone]} alt="" className="h-8 w-auto" />
    </Link>
  );
}

export { Mark };

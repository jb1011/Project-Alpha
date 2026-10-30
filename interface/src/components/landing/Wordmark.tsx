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
function Mark({ tone = "ink", className = "" }: { tone?: Tone; className?: string }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={MARK[tone]}
      alt=""
      width={1068}
      height={1000}
      className={`h-8 w-auto object-contain ${className}`}
    />
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
      <img
        src={MARK[tone]}
        alt=""
        width={1068}
        height={1000}
        className="h-8 w-auto sm:hidden"
      />
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={LOCKUP[tone]}
        alt=""
        width={2419}
        height={400}
        className="hidden h-8 w-auto sm:block"
      />
    </Link>
  );
}

export { Mark };

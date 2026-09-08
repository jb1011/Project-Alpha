import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /**
   * Nothing here may be framed.
   *
   * The vouch flow puts a one-click, irreversible, public statement about a person behind a button
   * on this origin (design 2026-08-25 v3 §5.1). Framed, that button is a clickjacking target: the
   * victim thinks they are approving something else, and what they actually publish to World Chain
   * can never be taken back. `frame-ancestors` is the only one of the three framing controls the
   * `X-Frame-Options` header cannot express well, and it is enforced on every route rather than
   * only the ones we remember to guard.
   */
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [{ key: "Content-Security-Policy", value: "frame-ancestors 'none'" }],
      },
    ];
  },
};

export default nextConfig;

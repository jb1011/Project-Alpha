import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async rewrites() {
    const target =
      process.env.API_PROXY_TARGET ?? "http://159.223.137.183:8789";
    return [
      {
        source: "/backend/:path*",
        destination: `${target}/:path*`,
      },
    ];
  },
};

export default nextConfig;

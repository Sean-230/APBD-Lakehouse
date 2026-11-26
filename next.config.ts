import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  experimental: {
    // Indexing thousands of rows takes minutes; the default proxy timeout is 30 seconds.
    proxyTimeout: 15 * 60 * 1000,
    // Uploads pass through middleware, which cuts bodies at 10 MB by default.
    middlewareClientMaxBodySize: "51mb",
  },
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: `${process.env.BACKEND_URL || "http://127.0.0.1:8000"}/api/:path*`,
      },
    ];
  },
};

export default nextConfig;

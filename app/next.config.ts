import type { NextConfig } from "next";

const basePath = process.env.NEXT_PUBLIC_BASE_PATH || "";
if (basePath && !/^\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+$/.test(basePath)) {
  throw new Error("NEXT_PUBLIC_BASE_PATH must be empty or a path like /designer (no trailing slash).");
}

const nextConfig: NextConfig = {
  basePath,
  // The PDF route reads its unit artwork and the logo from disk (src/lib/pdf/assets.ts).
  outputFileTracingIncludes: { "/api/pdf": ["./src/lib/pdf/assets/*.png", "./public/brand/**"] },
};
export default nextConfig;

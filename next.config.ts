import type { NextConfig } from "next";
const config: NextConfig = {
  distDir: process.env.CHAT_TEST_DIST_DIR ?? ".next",
  poweredByHeader: false,
  devIndicators: false,
  async headers() {
    return [{ source: "/:path*", headers: [
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "Referrer-Policy", value: "same-origin" },
      // UI assets are local; user attachment previews use data/blob URLs.
      { key: "Content-Security-Policy", value: "img-src 'self' data: blob:;" },
      { key: "X-Frame-Options", value: "DENY" },
      { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" }
    ] }];
  }
};
export default config;

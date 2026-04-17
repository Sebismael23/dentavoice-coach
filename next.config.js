/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: false, // Must be false — strict mode double-mounts, breaking audio/WebSocket resources
  // Since this is a personal local tool, we allow the Anthropic SDK to be bundled server-side only
  experimental: {
    serverActions: {
      bodySizeLimit: '2mb',
    },
  },
};

module.exports = nextConfig;

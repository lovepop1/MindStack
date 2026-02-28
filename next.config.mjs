/** @type {import('next').NextConfig} */
const nextConfig = {
    // Required so pdf-parse (a Node.js lib) works only in server routes
    experimental: {
        serverComponentsExternalPackages: ["pdf-parse"],
    },
};

export default nextConfig;

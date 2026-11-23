import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwind from "@tailwindcss/vite";

const previewProxies = {
  "/marketplace-api/": {
    target: "https://skills.sh",
    changeOrigin: true,
    rewrite: (path: string) => path.replace("/marketplace-api/", "/api/"),
  },
  "/marketplace-archive/": {
    target: "https://codeload.github.com",
    changeOrigin: true,
    rewrite: (path: string) => path.replace("/marketplace-archive/", "/"),
  },
};

export default defineConfig({
  plugins: [react(), tailwind()],
  clearScreen: false,
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: previewProxies,
  },
  preview: { proxy: previewProxies },
  build: {
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            {
              name: "react-runtime",
              test: /node_modules\/(react|react-dom|scheduler)\//,
            },
          ],
        },
      },
    },
  },
});

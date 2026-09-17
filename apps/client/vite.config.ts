import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig(({ mode }) => ({
  plugins: [react(), tailwindcss()],
  // Absolute for the web, relative for Tauri.
  //
  // Tauri serves from a local file origin where "/assets/…" resolves to the
  // filesystem root, so it needs "./". A web host needs the opposite: Vercel
  // rewrites every unmatched path to index.html, and a relative asset path on
  // /anything then resolves to /anything/assets/… — which is rewritten to
  // index.html in turn, and the browser refuses HTML where it asked for a
  // script. The page is blank with a MIME-type error and nothing says why.
  //
  // Driven by mode rather than an env var because `VITE_BASE=./ npm run build`
  // is not a thing cmd.exe understands, and the desktop app builds on Windows.
  base: mode === "desktop" ? "./" : "/",
  build: {
    outDir: "dist",
    sourcemap: false,
  },
  server: {
    port: 5173,
    // Tauri's devUrl is hardcoded to this port, so failing is better than
    // silently starting on 5174 and showing the desktop app a blank window.
    strictPort: true,
  },
}));

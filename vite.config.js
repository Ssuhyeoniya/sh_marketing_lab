import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Set base to repo name for GitHub Pages (https://<user>.github.io/sh_marketing_lab/).
// Override via env VITE_BASE='/' for local preview or custom domain.
const base = process.env.VITE_BASE ?? '/sh_marketing_lab/';

export default defineConfig({
  base,
  plugins: [react()],
  server: { port: 5173, host: true },
  optimizeDeps: { exclude: ['pdfjs-dist'] },
});

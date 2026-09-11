import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Relative base so the built site works from any static host path
// (GitHub Pages project sites, Cloudflare Pages, a plain folder, ...).
export default defineConfig({
  base: './',
  plugins: [react()],
});

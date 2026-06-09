import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
// Use the GitHub Pages base path for production builds, "/" in dev.
export default defineConfig(({ command }) => ({
  base: command === 'build' ? '/nosplay-real-pages/' : '/',
  plugins: [react()],
}))

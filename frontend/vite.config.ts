import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// 新前端與舊版 public/index.html 並存：build 產物由 server.ts 掛在 /next/ 底下，
// 所以 base 必須是 '/next/'，否則產出的資產路徑會指到根目錄、蓋掉舊版。
export default defineConfig({
  base: '/next/',
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true },
  server: {
    port: 8798,
    // dev server 直接把 API 轉給常駐的 tg-monitor（8799），開發時不必自己起後端
    proxy: { '/api': { target: 'http://127.0.0.1:8799', changeOrigin: true } },
  },
})

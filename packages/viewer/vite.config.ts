import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react-swc';
import tailwindcss from '@tailwindcss/vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

/**
 * Farview viewer 的构建配置。
 *
 * viteSingleFile 把 JS/CSS 全部内联进单个自包含 `dist/index.html`——CLI 构建时把它
 * 拷成 `packages/cli/viewer.html` 直接伺服，沿用「farview → 开 localhost:9229」的
 * 零依赖工作流（无散落资源、无需静态服务器）。
 * 迭代 viewer 本身时用 `pnpm dev:viewer` 走 HMR，连本地 relay。
 */
export default defineConfig({
  plugins: [react(), tailwindcss(), viteSingleFile()],
  server: {
    port: 8307,
  },
  build: {
    outDir: 'dist',
    // 单文件：禁用资源拆分相关阈值，全部内联
    assetsInlineLimit: 100_000_000,
  },
});

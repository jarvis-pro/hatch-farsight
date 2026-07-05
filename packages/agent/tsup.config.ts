import { defineConfig } from 'tsup';

/**
 * agent 构建：ESM + d.ts。
 * - `@rrweb/record` 保持 external —— 源码里的动态 `import('@rrweb/record')` 原样保留在产物里，
 *   由消费方 bundler（vite 等）解析并自然分包（镜像子 chunk，常规联调不下载）。
 * - `@farsight/protocol` 是纯类型 devDep：值域零输出，类型经 dts 内联进 dist/index.d.ts，
 *   消费方无需安装 protocol 包。
 */
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  external: ['@rrweb/record'],
});

import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

/**
 * Farsight ESLint 扁平配置（flat config）。
 *
 * - 只做「代码正确性」检查，格式一律交给 Prettier —— 末尾的 `prettier` 关掉所有会与
 *   Prettier 冲突的样式类规则，两者互不打架。
 * - 分包设定运行环境：viewer/agent 跑浏览器，cli 与各构建配置跑 Node。
 * - 不启用 type-checked 规则（无需 typed linting 的 project service），保持快、免配置。
 */
export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      'packages/cli/viewer.html',
      'packages/cli/bin.mjs.d.ts',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  // 全局规则微调：`_` 前缀的形参/变量/catch 绑定视为「有意未用」，不报错。
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
    },
  },

  // viewer —— React 19。只启用经典的高价值 hooks 规则。
  //
  // 刻意**不**采用 react-hooks v7 的 `recommended-latest`：它捆绑的是 React Compiler
  // 规则集（purity / immutability / refs / set-state-in-effect / incompatible-library 等），
  // 面向「代码将被 React Compiler 编译」的前提做静态约束。本项目用 @vitejs/plugin-react-swc、
  // 未启用 Compiler，那些规则会把大量正确写法（实时倒计时里的 Date.now、同步 open/外部 store
  // 的 setState、tanstack 虚拟化库的返回值等）误报为问题。
  //
  // react-refresh/only-export-components 也不启用：它只是 dev 阶段 fast-refresh 的边界提示，
  // 而 viewer 构建为单文件、且多处按 shadcn 约定让组件与工具/常量同文件——非缺陷。
  {
    files: ['packages/viewer/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser } },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },

  // agent —— 注入宿主页面，跑浏览器
  {
    files: ['packages/agent/**/*.ts'],
    languageOptions: { globals: { ...globals.browser } },
  },

  // cli relay —— Node 运行时（bin.mjs 用 JSDoc 注解，无 TS 语法）
  {
    files: ['packages/cli/**/*.{mjs,js}'],
    languageOptions: { globals: { ...globals.node } },
  },

  // 构建/工具配置文件跑在 Node
  {
    files: ['**/*.config.{ts,js,mjs}'],
    languageOptions: { globals: { ...globals.node } },
  },

  // 关闭与 Prettier 冲突的格式规则（必须放最后）
  prettier,
);

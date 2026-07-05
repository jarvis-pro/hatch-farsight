import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
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

  // viewer —— React 19（浏览器环境 + hooks 规则 + fast-refresh 约束）
  {
    files: ['packages/viewer/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser } },
    plugins: { 'react-hooks': reactHooks, 'react-refresh': reactRefresh },
    rules: {
      ...reactHooks.configs['recommended-latest'].rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      // react-hooks v7 新增的 React-Compiler 风格规则较激进，既有代码里多为合理写法：
      // 先降为 warn 作为改进提示，不阻断构建/CI；后续可逐条收紧为 error。
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/purity': 'warn',
      'react-hooks/immutability': 'warn',
      'react-hooks/refs': 'warn',
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

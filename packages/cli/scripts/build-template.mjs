// 从 @farview/example 生成 CLI 内置脚手架模板（packages/cli/template/）。
//
// 为什么要生成、而不是直接拷 example：example 是 monorepo 内的 workspace 成员，
// 依赖写 `workspace:*` / `catalog:`——这些协议只在仓库内可解析。脚手架释放到用户
// 机器上是**独立项目**，必须换成 registry 上的具体版本号。本脚本负责这层改写。
//
// 随 CLI 一起提交进仓库（与 viewer.html 同理），让 `npx github:<org>/repo example`
// 免构建即可用。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url)); // packages/cli/scripts
const cliRoot = path.join(here, '..'); // packages/cli
const exampleRoot = path.join(cliRoot, '..', 'example'); // packages/example
const workspaceYaml = path.join(cliRoot, '..', '..', 'pnpm-workspace.yaml');
const agentPkgPath = path.join(cliRoot, '..', 'agent', 'package.json');
const dest = path.join(cliRoot, 'template');

/** 从 pnpm-workspace.yaml 的 catalog 取某依赖的版本区间。 */
function catalogVersion(name) {
  const yaml = fs.readFileSync(workspaceYaml, 'utf8');
  const m = yaml.match(new RegExp(`^\\s*['"]?${name}['"]?:\\s*(\\S+)`, 'm'));
  if (!m) throw new Error(`catalog 里找不到依赖：${name}`);
  return m[1];
}

const agentVersion = JSON.parse(fs.readFileSync(agentPkgPath, 'utf8')).version;

// 1) 清空并重建目标目录
fs.rmSync(dest, { recursive: true, force: true });
fs.mkdirSync(dest, { recursive: true });

// 2) 原样拷贝源码资产
for (const asset of ['index.html', 'tsconfig.json', 'src']) {
  fs.cpSync(path.join(exampleRoot, asset), path.join(dest, asset), { recursive: true });
}

// 3) 改写 package.json：workspace:* / catalog: → 具体版本；换成用户侧独立项目的元信息
const src = JSON.parse(fs.readFileSync(path.join(exampleRoot, 'package.json'), 'utf8'));
const out = {
  name: 'farview-example',
  version: '0.0.0',
  private: true,
  type: 'module',
  scripts: src.scripts,
  dependencies: { '@farview/agent': `^${agentVersion}` },
  devDependencies: {
    typescript: catalogVersion('typescript'),
    vite: catalogVersion('vite'),
  },
};
fs.writeFileSync(path.join(dest, 'package.json'), JSON.stringify(out, null, 2) + '\n');

// 4) 给用户项目补一个 .gitignore（模板自身不需要，但释放出去的项目需要）
fs.writeFileSync(path.join(dest, '.gitignore'), 'node_modules/\ndist/\n*.log\n');

console.log(
  `[build-template] 模板已生成 → ${path.relative(cliRoot, dest)}（agent ^${agentVersion}）`,
);

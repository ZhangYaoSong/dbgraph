# DBGraph Agents Guide

数据库知识图谱 —— 将数据库 schema 提取为本地知识图谱，通过 MCP 供 LLM 理解库表结构。

## 项目概览

DBGraph 是一个 TypeScript CLI + MCP Server，内省数据库 schema 存入 SQLite（含 FTS5 全文搜索），以知识图谱方式暴露给 AI Agent。

- **CLI 入口**: `src/bin/dbgraph.ts` → 构建产物 `dist/bin/dbgraph.js`
- **主类**: `src/index.ts` 的 `DBGraph` 类
- **类型定义全集**: `src/types.ts`
- **数据库内省**: `src/introspect/` 下每个引擎一个文件（`postgres.ts`, `mysql.ts`, `sqlite.ts`, `mssql.ts`, `mongodb.ts`），继承 `BaseIntrospector`
- **MCP Server**: `src/mcp/`，支持 stdio 模式和 daemon socket 模式
- **图形遍历**: `src/graph/traversal.ts`（BFS/DFS/寻路）

## 开发命令

```bash
npm install          # 安装依赖
npm run build        # tsc + 复制 schema.sql + chmod
npm run dev          # tsc --watch
npm run cli -- <args>  # build 后自动执行 node dist/bin/dbgraph.js
npm test             # vitest run（当前无测试文件）
npm run clean        # 删除 dist/
```

**构建注意**: `npm run build` 会执行 `tsc`，然后通过 inline 脚本复制 `src/db/schema.sql` 到 `dist/db/` 并给 CLI 加可执行权限。如果改了 schema.sql，必须重新 build。

## 架构要点

- **Node.js >= 22.5.0** — 依赖 `node:sqlite` 内置模块，低版本不可用
- **CommonJS 模块** — `tsconfig.json` 中 `module: "commonjs"`
- **SQLite 存储**: `.dbgraph/dbgraph.db`，核心表 `nodes` + `edges` + `db_sources` + `nodes_fts`（FTS5）
- **配置文件名**: `dbgraph-db.json`，支持 JSONC（带注释）
- **配置发现**: `findConfigFile()` 从当前目录向上递归查找
- **并发安全**: `FileLock`（跨进程文件锁）+ `Mutex`（进程内互斥锁）
- **节点 ID**: 通过 `hashString()` 对 qualified name 取哈希（非加密，仅稳定标识）

## CLI 命令速查

所有命令格式：`node dist/bin/dbgraph.js <命令> [选项] [目录]`
或使用快捷方式：`npm run cli -- <命令> [选项] [目录]`

| 命令 | 用途 |
|---|---|
| `init [dir]` | 初始化 `.dbgraph` 项目 + 可选 `--index` + 可选 `-c` 配置 |
| `index [dir]` | 运行数据库内省，提取 schema |
| `serve [dir]` | 启动 MCP stdio 服务器（`--daemon` 后台模式，`--auto-refresh` 自动刷新） |
| `query <词> [dir]` | 搜索表/列/视图/索引（`--kind table`, `--json`, `--limit N`） |
| `context <表名> [dir]` | 查看完整表结构（支持 `schema.table` 限定名） |
| `status [dir]` | 知识图谱状态统计 |
| `sources [dir]` | 列出数据源 |
| `test [dir]` | 测试数据库连接（`-c` 指定配置） |
| `config [dir]` | 查看/创建配置（`--init` 创建默认配置） |

## MCP 工具（由 `serve` 暴露）

| 工具 | 用途 |
|---|---|
| `dbgraph_search` | 搜索表/列/视图/索引 |
| `dbgraph_context` | 返回完整表结构 + 列 + FK + 索引（写 SQL 前必调） |
| `dbgraph_trace` | 追踪 FK 关联路径（找 JOIN 链路） |
| `dbgraph_explore` | 一次探索多张表 |
| `dbgraph_sources` | 列出已配置数据库源 |
| `dbgraph_status` | 知识图谱统计 |

## 添加新数据库引擎

1. 在 `src/introspect/` 下创建新文件，实现 `BaseIntrospector` 抽象类
2. 在 `src/introspect/index.ts` 的 `createIntrospector()` factory 中注册
3. 在 `src/types.ts` 的 `DB_ENGINES` 数组中添加引擎名

## 测试现状

- **无测试文件** — `__tests__/` 目录不存在，也没有 `*.spec.ts` / `*.test.ts`
- vitest 已安装但未配置（无 `vitest.config.*`），靠默认配置运行
- 如果添加测试，在 `__tests__/` 下创建即可

## 使用 CodeGraph

本项目已初始化 CodeGraph 索引（`.codegraph/`）。查询结构信息时优先使用 codegraph 工具而非 grep：

- `codegraph_context` — 理解某模块的用途和结构
- `codegraph_search` — 按符号名查找定义位置
- `codegraph_explore` — 同时查看多个相关符号的源码
- `codegraph_impact` — 分析修改一个符号的影响范围

# DBGraph

[![npm version](https://img.shields.io/npm/v/dbgraph)](https://www.npmjs.com/package/dbgraph)
[![License](https://img.shields.io/npm/l/dbgraph)](LICENSE)
[![Node](https://img.shields.io/node/v/dbgraph)](https://nodejs.org)

数据库知识图谱 —— 将数据库 schema 提取为本地知识图谱，通过 MCP 供 LLM 理解库表结构，从而减少 SQL 生成错误。

## 原理

LLM 写 SQL 犯错的最大原因是**不知道你的库有什么**——表名靠猜、列名靠蒙、JOIN 条件靠碰运气。DBGraph 把数据库的 schema 信息（表、列、类型、外键、约束、索引）全部提取成一个**可搜索的知识图谱**存在 `.dbgraph/` 目录下，LLM 通过 MCP 工具直接查询，不直接连数据库。

```
传统流程:
  LLM → 猜表名列名 → 写 SQL → 执行 → 报错 → 再猜 → 循环

DBGraph 流程:
  LLM → dbgraph_context("orders") → 拿到精确 schema
       → 写 SQL → dbgraph_execute → 成功
```

## 快速安装

```bash
# 全局安装
npm install -g dbgraph

# 或直接用 npx（无需安装）
npx dbgraph --help
```

## 前置要求

- **Node.js >= 22.5.0**（需要内置 `node:sqlite` 支持 FTS5 + WAL）

## 快速开始

> 安装后直接使用 `dbgraph` 命令。如需本地开发，可用 `npm run cli -- <命令>` 替代（自动先构建）。

### 1. 初始化项目

所有命令默认使用当前目录，也可指定目录路径。

```bash
# 初始化当前目录
dbgraph init

# 初始化并立即索引（一步完成）
dbgraph init -i

# 初始化指定目录
dbgraph init ./demo-project
```

这会创建：
- `.dbgraph/` —— 知识图谱数据目录
- `dbgraph-db.json` —— 数据库连接配置（默认模板）

### 2. 配置数据库连接

编辑 `demo-project/dbgraph-db.json`，填入你的数据库信息：

```json
{
  "databases": [
    {
      "alias": "prod",
      "engine": "postgresql",
      "host": "localhost",
      "port": 5432,
      "database": "ecommerce",
      "schemas": ["public"],
      "auth": "env:DB_PASSWORD"
    },
    {
      "alias": "local",
      "engine": "sqlite",
      "path": "./dev.db"
    }
  ]
}
```

### 3. 提取 Schema

```bash
dbgraph index
```

把数据库 schema 提取到知识图谱中。首次运行会连接所有配置的数据库，提取表/列/外键/索引/视图等信息。

### 4. 查询知识图谱

```bash
# 搜索表/列
dbgraph query orders
dbgraph query users --kind table

# 查看完整表结构
dbgraph context public.orders

# 查看状态
dbgraph status

# 列出数据源
dbgraph sources
```

## 配置说明

### `dbgraph-db.json`

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `alias` | string | 是 | 数据库别名，在知识图谱中用 `db://@alias` 标识 |
| `engine` | string | 是 | 数据库引擎：`postgresql` / `mysql` / `mariadb` / `sqlite` |
| `host` | string | 否 | 主机地址（SQLite 不需要）|
| `port` | number | 否 | 端口（默认根据引擎判断）|
| `database` | string | 是(非SQLite) | 数据库名 |
| `schemas` | string[] | 否 | 要提取的 schema 列表（默认全部）|
| `path` | string | 是(SQLite) | SQLite 文件路径 |
| `auth` | string | 否 | 认证方式，如 `env:DB_PASSWORD`（环境变量）、`~/.pgpass` |
| `ssl` | boolean | 否 | 是否启用 SSL 连接 |

## CLI 命令参考

所有命令格式：`dbgraph <命令> [选项] [目录]`

不填目录时默认为当前目录。

| 命令 | 说明 |
|------|------|
| `init` | 初始化 .dbgraph 项目 + 配置 |
| `index` | 运行数据库内省，提取 schema |
| `serve` | 启动 MCP 服务器（供 AI Agent 使用）|
| `query` | 搜索表/列/视图 |
| `context` | 查看完整表结构 |
| `status` | 知识图谱状态统计 |
| `sources` | 列出数据源 |
| `test` | 测试数据库连接 |
| `config` | 查看/创建配置 |

### `init`

```bash
# 初始化当前目录
dbgraph init

# 初始化并立即索引
dbgraph init -i

# 初始化指定目录
dbgraph init ./my-project

# 指定配置文件路径
dbgraph init ./my-project -c ./my-project/custom-config.json
```

### `index`

```bash
# 索引当前目录配置的数据库
dbgraph index

# 指定配置文件
dbgraph index ./my-project -c ./my-project/custom-config.json
```

### `serve`（MCP 模式）

```bash
# 启动 MCP stdio 服务器（当前目录）
dbgraph serve

# 指定项目目录
dbgraph serve ./my-project
```

AI Agent 连接到 MCP 后自动发现 `dbgraph_*` 工具。

### `query`

```bash
# 搜索
dbgraph query orders

# 按类型过滤
dbgraph query orders --kind table
dbgraph query amount --kind column

# JSON 格式输出
dbgraph query orders --json
```

### `context`

```bash
# 查看表结构
dbgraph context orders
dbgraph context public.orders
```

输出示例：
```
## Table: public.orders

Database: prod (postgresql)

| Column       | Type         | Nullable | Default  | PK | FK        |
|-------------|-------------|----------|----------|----|-----------|
| id          | bigint       | NO       |          | PK |           |
| user_id     | integer      | NO       |          |    | users.id  |
| status      | varchar(20)  | NO       | pending  |    |           |
| total_amount| numeric(10,2)| YES      | 0.00     |    |           |
| created_at  | timestamp    | NO       | now()    |    |           |

Indexes:
  - idx_orders_status on (status)
  - pk_orders PRIMARY KEY using btree (id)

Foreign Keys:
  - fk_orders_user → users(id) ON DELETE CASCADE
```

## MCP 工具

启动 `dbgraph serve` 后，AI Agent 可以调用以下工具：

| 工具 | 用途 | 推荐时机 |
|------|------|---------|
| `dbgraph_search` | 搜索表/列/视图/索引 | 不确定名字时 |
| `dbgraph_context` | **主要入口** —— 返回完整表结构 + 列 + FK + 索引 | 写 SQL 前 |
| `dbgraph_trace` | 追踪 FK 关联路径（orders→users） | 需要写 JOIN 时 |
| `dbgraph_explore` | 一次性探索多张相关表 | 复杂查询涉及多表时 |
| `dbgraph_sources` | 列出所有已配置的数据库源 | 了解有哪些库可用 |
| `dbgraph_status` | 知识图谱统计 | 检查是否已索引 |

### 推荐工具调用策略

```
写 SQL 前的标准流程:
1. dbgraph_search("order")        → 找到 order 相关表
2. dbgraph_context("public.orders") → 获取完整 schema
3. dbgraph_context("public.users")   → 获取关联表 schema
4. dbgraph_trace("orders", "users")  → 验证 FK 关联
5. LLM 写出精确 SQL
```

## 支持引擎

| 引擎 | 状态 | 说明 |
|------|------|------|
| PostgreSQL | ✅ 完整支持 | `information_schema` + `pg_catalog` |
| MySQL / MariaDB | ✅ 完整支持 | `information_schema` |
| SQLite | ✅ 完整支持 | `pragma table_info` / `foreign_key_list` |
| SQL Server | 🔜 计划中 | |
| Oracle | 🔜 计划中 | |
| MongoDB | 🔜 计划中 | |

## 项目结构

```
dbgraph/
├── src/
│   ├── index.ts                        # DBGraph 主类
│   ├── types.ts                        # 所有类型 (Node, Edge, TableSchema...)
│   ├── config.ts                       # dbgraph-db.json 配置管理
│   ├── directory.ts                    # .dbgraph 目录管理
│   ├── errors.ts                       # 错误类型
│   ├── utils.ts                        # 工具函数
│   │
│   ├── db/                             # SQLite 存储层
│   │   ├── schema.sql                  # 表结构 (nodes/edges FTS5)
│   │   ├── sqlite-adapter.ts           # node:sqlite 适配
│   │   ├── migrations.ts               # 版本迁移
│   │   ├── queries.ts                  # CRUD + FTS5 搜索 + 评分 (LRU缓存)
│   │   └── index.ts                    # 连接管理
│   │
│   ├── graph/
│   │   └── traversal.ts                # BFS/DFS/寻路/影响半径
│   │
│   ├── context/
│   │   ├── index.ts                    # 表结构组装
│   │   └── formatter.ts                # Markdown 输出
│   │
│   ├── introspect/                     # 数据库内省
│   │   ├── base.ts                     # 基类 + Node/Edge 工厂
│   │   ├── index.ts                    # 工厂方法
│   │   ├── connection.ts               # 连接管理
│   │   ├── postgres.ts                 # PostgreSQL
│   │   ├── mysql.ts                    # MySQL
│   │   └── sqlite.ts                   # SQLite
│   │
│   ├── mcp/                            # MCP 服务器
│   │   ├── transport.ts                # JSON-RPC 传输
│   │   ├── session.ts                  # 会话管理
│   │   ├── engine.ts                   # 引擎 + 生命周期
│   │   ├── tools.ts                    # 6 个 dbgraph_* 工具
│   │   ├── server-instructions.ts      # LLM 指引
│   │   └── index.ts                    # MCPServer
│   │
│   └── bin/
│       └── dbgraph.ts                  # CLI
```

## 开发

```bash
# 安装依赖
npm install

# 构建
npm run build

# 开发模式（watch）
npm run dev

# 运行帮助
npm run cli -- --help
```

### 添加新数据库引擎

在 `src/introspect/` 下创建新文件（如 `mssql.ts`），实现 `BaseIntrospector` 抽象类：

```typescript
import { BaseIntrospector } from './base';

export class MSSQLIntrospector extends BaseIntrospector {
  async extractAll(): Promise<IntrospectResult> {
    // 1. 连接数据库
    // 2. 查询 information_schema
    // 3. 调用 this.makeNode() / this.makeEdge()
    // 4. 返回 IntrospectResult
  }
}
```

然后在 `src/introspect/index.ts` 中注册：

```typescript
case 'mssql':
  return new MSSQLIntrospector(config);
```

## 参考

- **[AGENTS.md](AGENTS.md)** — OpenCode AI Agent 的项目指引，包含开发命令速查、架构要点和 CodeGraph 使用说明。
- **CodeGraph** — 本项目已初始化 CodeGraph 索引（`.codegraph/`），Agent 可优先使用 `codegraph_*` 工具进行结构查询，速度远超 grep。

## 鸣谢

DBGraph 的架构和 MCP 设计受到了 [CodeGraph](https://github.com/colbymchenry/codegraph) 的启发。CodeGraph 是一个优秀的代码知识图谱工具，将代码库结构提取为可查询的知识图谱，本项目借鉴了其思路并将其应用于数据库 schema 领域。

## License

MIT

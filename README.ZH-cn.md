<div align="center">

# DBGraph

### 数据库知识图谱 — 将数据库 schema 提取为知识图谱，通过 MCP 供 AI 代理使用

**零猜测 SQL 生成 · 亚毫秒级 schema 查询 · 100% 本地运行**

[![npm version](https://img.shields.io/npm/v/dbgraph)](https://www.npmjs.com/package/dbgraph)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/Node.js-%3E%3D22.5-brightgreen)](https://nodejs.org/)

[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-支持-blue)](#支持引擎)
[![MySQL](https://img.shields.io/badge/MySQL-支持-blue)](#支持引擎)
[![SQLite](https://img.shields.io/badge/SQLite-支持-blue)](#支持引擎)

</div>

## 快速开始

```bash
# 零安装（推荐）
npx dbgraph

# 或全局安装
npm i -g dbgraph
```

### 初始化项目

```bash
cd your-project
npx dbgraph init -i       # 一步完成初始化 + 索引
```

<sub>`dbgraph init` 创建 `.dbgraph/` 目录和默认 `dbgraph-db.json` 配置。加上 `-i`（`--index`）会立即内省数据库。编辑 `dbgraph-db.json` 配置数据库连接。</sub>

### 启动 MCP 服务器

```bash
npx dbgraph serve
```

AI 代理连接 MCP 后自动发现 `dbgraph_*` 工具，用于 schema 感知的 SQL 生成。

## 为什么用 DBGraph？

LLM 写 SQL 出错的最大原因是**不知道库表结构**——表名靠猜、列名靠蒙、JOIN 条件靠碰运气。DBGraph 把数据库 schema（表、列、类型、外键、约束、索引）提取为**可搜索的知识图谱**存在 `.dbgraph/` 中。AI 代理通过 MCP 工具直接查询，无需数据库直连。

```
传统流程:
  LLM → 猜名列名 → 写 SQL → 报错 → 再猜 → 循环

DBGraph 流程:
  LLM → dbgraph_context("orders") → 拿到精确 schema
       → 写 SQL → 成功
```

## CLI 命令

| 命令 | 说明 |
|---------|-------------|
| `init` | 初始化 `.dbgraph` 项目（`-i` 立即索引）|
| `index` | 运行数据库内省 |
| `serve` | 启动 MCP 服务器（`--auto-refresh` 自动检测 schema 变更）|
| `query` | 搜索表、列、视图、索引 |
| `context` | 查看完整表结构（写 SQL 前必调）|
| `trace` | 追踪外键关联路径 |
| `explore` | 批量查看多张表 schema |
| `sources` | 列出已配置的数据库源 |
| `status` | 知识图谱统计 |
| `test` | 测试数据库连接 |
| `config` | 查看或创建配置 |

所有命令默认使用当前目录，也可指定目录：

```bash
npx dbgraph status                  # 当前目录
npx dbgraph status ./other-project  # 其他项目
```

## MCP 工具

启动 `dbgraph serve` 后，AI 代理可调用：

| 工具 | 用途 |
|------|---------|
| `dbgraph_search` | 按名称搜索 schema 对象 |
| `dbgraph_context` | **完整表结构** — 列、类型、主键、外键、索引 |
| `dbgraph_trace` | 追踪外键关联路径（orders → users）|
| `dbgraph_explore` | 批量查看多张表 |
| `dbgraph_sources` | 列出所有数据库源 |
| `dbgraph_status` | 图谱健康状态与统计 |

## 配置说明

编辑项目根目录的 `dbgraph-db.json`：

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

| 字段 | 类型 | 必填 | 说明 |
|-------|------|----------|-------------|
| `alias` | string | 是 | 数据库别名（图谱中以 `db://@alias` 标识）|
| `engine` | string | 是 | `postgresql` / `mysql` / `mariadb` / `sqlite` |
| `host` | string | 否 | 主机地址 |
| `port` | number | 否 | 端口（默认根据引擎判断）|
| `database` | string | 视情况 | PostgreSQL/MySQL 必填 |
| `schemas` | string[] | 否 | 要提取的 schema 列表（默认全部）|
| `path` | string | 视情况 | SQLite 必填 |
| `auth` | string | 否 | `env:VAR_NAME` 或 `~/.pgpass` |
| `ssl` | boolean | 否 | 启用 SSL |

## 支持引擎

| 引擎 | 状态 |
|--------|------|
| PostgreSQL | ✅ 完整支持 |
| MySQL / MariaDB | ✅ 完整支持 |
| SQLite | ✅ 完整支持 |
| SQL Server | 🔜 计划中 |
| Oracle | 🔜 计划中 |

## 开发

```bash
git clone https://github.com/ZhangYaoSong/dbgraph.git
cd dbgraph
npm install
npm run build
npm run cli -- init -i   # 初始化当前目录 + 索引
npm run cli -- serve      # 从源码启动 MCP 服务器
```

## 鸣谢

受 [CodeGraph](https://github.com/colbymchenry/codegraph) 启发——一个优秀的代码知识图谱工具，本项目将其思路应用于数据库 schema 领域。

## 许可证

MIT

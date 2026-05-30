#!/usr/bin/env node

/**
 * DBGraph CLI
 *
 * Command-line interface for the database knowledge graph.
 */

import * as path from 'path';
import * as fs from 'fs';
import { Command } from 'commander';
import { DBGraph } from '../index';
import { DBGraphConfig, CONFIG_FILENAME, loadConfig, findConfigFile, generateDefaultConfig } from '../config';
import { SchemaFormatter } from '../context/formatter';
import { createIntrospector } from '../introspect';
import { MCPServer } from '../mcp';

const program = new Command();

program
  .name('dbgraph')
  .description('Database knowledge graph for LLM-powered SQL generation')
  .version('0.1.0');

// ===========================================================================
// init
// ===========================================================================

program
  .command('init')
  .description('Initialize a .dbgraph project (create directory + config + optional index)')
  .argument('[directory]', 'Project root directory', '.')
  .option('-c, --config <path>', 'Path to dbgraph-db.json config file')
  .option('--index', 'Run initial indexing after init')
  .action(async (directory: string, opts: { config?: string; index?: boolean }) => {
    const projectRoot = path.resolve(directory);

    // Check not already initialized
    if (DBGraph.isInitialized(projectRoot)) {
      console.error(`DBGraph already initialized in ${projectRoot}`);
      process.exit(1);
    }

    // Check if config exists or needs to be created
    const configPath = opts.config || path.join(projectRoot, CONFIG_FILENAME);
    if (!fs.existsSync(configPath)) {
      console.log(`No ${CONFIG_FILENAME} found. Creating default config...`);
      fs.writeFileSync(configPath, generateDefaultConfig(), 'utf-8');
      console.log(`Created ${configPath}`);
      console.log('Edit this file to add your database connections, then run: dbgraph index');
    }

    console.log(`Initializing DBGraph in ${projectRoot}...`);
    const cg = await DBGraph.init(projectRoot, {
      config: configPath,
      index: opts.index,
      onProgress: (msg: string, current: number, total: number) => {
        process.stdout.write(`\r${msg} [${current}/${total}]`);
        if (current >= total) process.stdout.write('\n');
      },
    });

    console.log('Done.');
    console.log(`Data directory: ${projectRoot}${path.sep}.dbgraph`);
    cg.close();
  });

// ===========================================================================
// index
// ===========================================================================

program
  .command('index')
  .description('Run database introspection to populate the knowledge graph')
  .argument('[directory]', 'Project root directory', '.')
  .option('-c, --config <path>', 'Path to dbgraph-db.json config file')
  .action(async (directory: string, opts: { config?: string }) => {
    const projectRoot = path.resolve(directory);

    if (!DBGraph.isInitialized(projectRoot)) {
      console.error(`DBGraph not initialized in ${projectRoot}. Run 'dbgraph init' first.`);
      process.exit(1);
    }

    const cg = await DBGraph.open(projectRoot);

    // Override config if specified
    if (opts.config) {
      cg.setConfig(loadConfig(opts.config));
    }

    if (!cg.getConfig()) {
      // Try auto-discovering config
      const configPath = findConfigFile(projectRoot);
      if (configPath) {
        cg.setConfig(loadConfig(configPath));
      } else {
        console.error('No database configuration found.');
        console.error(`Create a ${CONFIG_FILENAME} file or pass --config.`);
        process.exit(1);
      }
    }

    const config = cg.getConfig()!;
    console.log(`Found ${config.databases.length} database(s) configured:\n`);
    for (const db of config.databases) {
      const hostPort = db.host ? `${db.host}:${db.port || 'default'}` : 'local';
      const schemas = db.schemas?.length ? ` (schemas: ${db.schemas.join(', ')})` : '';
      console.log(`  ${db.alias.padEnd(20)} ${db.engine.padEnd(12)} ${hostPort}/${db.database}${schemas}`);
    }

    console.log('\nRunning introspection...\n');
    const result = await cg.indexAll({
      onProgress: (msg: string, current: number, total: number) => {
        process.stdout.write(`\r${msg} [${current}/${total}]`);
        if (current >= total) process.stdout.write('\n');
      },
    });

    console.log('\nIndexing complete:');
    console.log(`  Sources indexed: ${result.sourcesIndexed}`);
    console.log(`  Nodes created:   ${result.nodesCreated}`);
    console.log(`  Edges created:   ${result.edgesCreated}`);

    if (result.errors.length > 0) {
      console.log('\nErrors:');
      for (const err of result.errors) {
        console.log(`  ⚠ ${err}`);
      }
    }

    cg.close();
  });

// ===========================================================================
// serve (MCP)
// ===========================================================================

program
  .command('serve')
  .description('Start the MCP server (stdio mode for AI agents)')
  .argument('[directory]', 'Project root directory', '.')
  .option('--mcp', 'Start in MCP mode (default)', true)
  .option('--daemon', 'Start as a background daemon process')
  .option('--path <path>', 'Explicit project path (for agents that don\'t set rootUri)')
  .option('--auto-refresh', 'Check & re-index database schemas on each MCP tool call', false)
  .action(async (directory: string, opts: { mcp?: boolean; daemon?: boolean; path?: string; autoRefresh?: boolean }) => {
    const projectRoot = path.resolve(directory);

    // Don't crash if not initialized — MCP engine handles this gracefully
    // via background init + lazy retry. Tool calls will return proper errors
    // until the user runs `dbgraph init`.

    const server = new MCPServer({
      projectPath: opts.path || projectRoot,
      autoRefresh: opts.autoRefresh,
    });

    if (opts.daemon) {
      console.error('Starting DBGraph daemon...');
      await server.startDaemon(projectRoot);
    } else {
      server.start();
    }
  });

// ===========================================================================
// query / search
// ===========================================================================

program
  .command('query')
  .description('Search the database knowledge graph')
  .argument('<query>', 'Search term')
  .argument('[directory]', 'Project root directory', '.')
  .option('-k, --kind <kind>', 'Filter by node kind (table, column, view, index, constraint)')
  .option('-l, --limit <number>', 'Maximum results', '20')
  .option('--json', 'Output as JSON')
  .action(async (query: string, directory: string, opts: { kind?: string; limit?: string; json?: boolean }) => {
    const projectRoot = path.resolve(directory);

    if (!DBGraph.isInitialized(projectRoot)) {
      console.error(`DBGraph not initialized in ${projectRoot}. Run 'dbgraph init' first.`);
      process.exit(1);
    }

    const cg = DBGraph.openSync(projectRoot);
    const limit = parseInt(opts.limit || '20', 10);

    const results = cg.searchNodes(query, {
      kinds: opts.kind ? [opts.kind as any] : undefined,
      limit,
    });

    if (opts.json) {
      console.log(JSON.stringify(results, null, 2));
    } else {
      const formatter = new SchemaFormatter();
      console.log(formatter.formatSearchResults(results));
    }

    cg.close();
  });

// ===========================================================================
// context
// ===========================================================================

program
  .command('context')
  .description('Show full schema context for a table')
  .argument('<name>', 'Table name or qualified name')
  .argument('[directory]', 'Project root directory', '.')
  .action(async (name: string, directory: string) => {
    const projectRoot = path.resolve(directory);

    if (!DBGraph.isInitialized(projectRoot)) {
      console.error(`DBGraph not initialized in ${projectRoot}. Run 'dbgraph init' first.`);
      process.exit(1);
    }

    const cg = DBGraph.openSync(projectRoot);
    const context = await cg.buildContext(name);
    console.log(context);
    cg.close();
  });

// ===========================================================================
// status
// ===========================================================================

program
  .command('status')
  .description('Show DBGraph status and statistics')
  .argument('[directory]', 'Project root directory', '.')
  .action(async (directory: string) => {
    const projectRoot = path.resolve(directory);

    if (!DBGraph.isInitialized(projectRoot)) {
      console.error(`DBGraph not initialized in ${projectRoot}. Run 'dbgraph init' first.`);
      process.exit(1);
    }

    const cg = DBGraph.openSync(projectRoot);
    const stats = cg.getStats();
    const sources = cg.getSources();
    const configPath = findConfigFile(projectRoot);

    console.log('\n=== DBGraph Status ===\n');

    if (configPath) {
      console.log(`Config: ${configPath}`);
    }
    console.log(`Project root: ${projectRoot}`);
    console.log(`DBGraph dir:  ${projectRoot}${path.sep}.dbgraph`);
    const journalMode = cg.getJournalMode();
    console.log(`Journal mode: ${journalMode}\n`);

    console.log('Graph Statistics:');
    console.log(`  Node count:  ${stats.nodeCount.toLocaleString()}`);
    console.log(`  Edge count:  ${stats.edgeCount.toLocaleString()}`);
    console.log(`  Databases:   ${stats.dbCount}`);
    console.log(`  DB size:     ${(stats.dbSizeBytes / 1024).toFixed(1)} KB\n`);

    if (Object.keys(stats.nodesByKind).length > 0) {
      console.log('Nodes by kind:');
      for (const [kind, count] of Object.entries(stats.nodesByKind).sort((a, b) => b[1] - a[1])) {
        console.log(`  ${kind.padEnd(16)} ${count}`);
      }
      console.log('');
    }

    if (sources.length > 0) {
      console.log('Database sources:');
      for (const src of sources) {
        const time = new Date(src.indexedAt).toLocaleString();
        console.log(`  ${src.alias.padEnd(16)} ${src.engine.padEnd(10)} ${src.displayUri}`);
        console.log(`  ${''.padEnd(16)} Indexed: ${time}, Nodes: ${src.nodeCount}`);
      }
    } else {
      console.log('No databases indexed yet. Run: dbgraph index');
    }

    cg.close();
  });

// ===========================================================================
// sources
// ===========================================================================

program
  .command('sources')
  .description('List configured database sources')
  .argument('[directory]', 'Project root directory', '.')
  .option('--json', 'Output as JSON')
  .action(async (directory: string, opts: { json?: boolean }) => {
    const projectRoot = path.resolve(directory);

    if (!DBGraph.isInitialized(projectRoot)) {
      console.error(`DBGraph not initialized in ${projectRoot}. Run 'dbgraph init' first.`);
      process.exit(1);
    }

    const cg = DBGraph.openSync(projectRoot);
    const sources = cg.getSources();

    if (opts.json) {
      console.log(JSON.stringify(sources, null, 2));
    } else {
      const formatter = new SchemaFormatter();
      const stats = cg.getStats();
      console.log(formatter.formatDatabaseOverview(sources, stats));
    }

    cg.close();
  });

// ===========================================================================
// test
// ===========================================================================

program
  .command('test')
  .description('Test connections to all configured databases')
  .argument('[directory]', 'Project root directory', '.')
  .option('-c, --config <path>', 'Path to dbgraph-db.json config file')
  .action(async (directory: string, opts: { config?: string }) => {
    const projectRoot = path.resolve(directory);

    // Load config
    const configPath = opts.config || findConfigFile(projectRoot);
    if (!configPath) {
      console.error(`No ${CONFIG_FILENAME} found.`);
      process.exit(1);
    }

    const config = loadConfig(configPath);
    console.log(`Testing ${config.databases.length} database(s)...\n`);

    let allOk = true;
    for (const db of config.databases) {
      process.stdout.write(`  ${db.alias} (${db.engine})... `);
      try {
        const introspector = createIntrospector(db);
        const ok = await introspector.testConnection();
        if (ok) {
          console.log('✅ OK');
        } else {
          console.log('❌ FAILED (connection returned false)');
          allOk = false;
        }
      } catch (err) {
        console.log(`❌ FAILED`);
        console.log(`    ${err instanceof Error ? err.message : String(err)}`);
        allOk = false;
      }
    }

    console.log(allOk ? '\nAll connections successful!' : '\nSome connections failed.');
    process.exit(allOk ? 0 : 1);
  });

// ===========================================================================
// config
// ===========================================================================

program
  .command('config')
  .description('Show or edit the dbgraph-db.json configuration')
  .argument('[directory]', 'Project root directory', '.')
  .option('--show', 'Display the config file contents')
  .option('--init', 'Create a default config file')
  .action(async (directory: string, opts: { show?: boolean; init?: boolean }) => {
    const projectRoot = path.resolve(directory);
    const configPath = findConfigFile(projectRoot) || path.join(projectRoot, CONFIG_FILENAME);

    if (opts.init) {
      if (fs.existsSync(configPath)) {
        console.error(`${configPath} already exists.`);
        process.exit(1);
      }
      fs.writeFileSync(configPath, generateDefaultConfig(), 'utf-8');
      console.log(`Created ${configPath}`);
      console.log('Edit this file to add your database connections, then run: dbgraph index');
      return;
    }

    if (!fs.existsSync(configPath)) {
      console.error(`No ${CONFIG_FILENAME} found. Use --init to create one.`);
      process.exit(1);
    }

    if (opts.show) {
      const raw = fs.readFileSync(configPath, 'utf-8');
      console.log(raw);
    }
  });

// ===========================================================================
// Parse
// ===========================================================================

program.parse(process.argv);

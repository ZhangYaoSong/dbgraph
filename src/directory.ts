/**
 * Directory Management
 *
 * Manages the .dbgraph/ directory structure for DBGraph data.
 */

import * as fs from 'fs';
import * as path from 'path';

/**
 * DBGraph directory name
 */
export const DBGRAPH_DIR = '.dbgraph';

/**
 * Get the .dbgraph directory path for a project
 */
export function getDBGraphDir(projectRoot: string): string {
  return path.join(projectRoot, DBGRAPH_DIR);
}

/**
 * Check if a project has been initialized with DBGraph
 */
export function isInitialized(projectRoot: string): boolean {
  const dbgraphDir = getDBGraphDir(projectRoot);
  if (!fs.existsSync(dbgraphDir) || !fs.statSync(dbgraphDir).isDirectory()) {
    return false;
  }
  const dbPath = path.join(dbgraphDir, 'dbgraph.db');
  return fs.existsSync(dbPath);
}

/**
 * Find the nearest parent directory containing .dbgraph/
 */
export function findNearestDBGraphRoot(startPath: string): string | null {
  let current = path.resolve(startPath);
  const root = path.parse(current).root;

  while (current !== root) {
    if (isInitialized(current)) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  if (isInitialized(current)) {
    return current;
  }

  return null;
}

/**
 * Create the .dbgraph directory structure
 */
export function createDirectory(projectRoot: string): void {
  const dbgraphDir = getDBGraphDir(projectRoot);
  const dbPath = path.join(dbgraphDir, 'dbgraph.db');

  if (fs.existsSync(dbPath)) {
    throw new Error(`DBGraph already initialized in ${projectRoot}`);
  }

  fs.mkdirSync(dbgraphDir, { recursive: true });

  // Create .gitignore inside .dbgraph
  const gitignorePath = path.join(dbgraphDir, '.gitignore');
  if (!fs.existsSync(gitignorePath)) {
    const gitignoreContent = [
      '# DBGraph data files',
      '# These are local to each machine and should not be committed',
      '',
      '# Database',
      '*.db',
      '*.db-wal',
      '*.db-shm',
      '',
      '# Cache',
      'cache/',
      '',
      '# Logs',
      '*.log',
    ].join('\n');
    fs.writeFileSync(gitignorePath, gitignoreContent, 'utf-8');
  }
}

/**
 * Remove the .dbgraph directory
 */
export function removeDirectory(projectRoot: string): void {
  const dbgraphDir = getDBGraphDir(projectRoot);
  if (!fs.existsSync(dbgraphDir)) {
    return;
  }

  const lstat = fs.lstatSync(dbgraphDir);
  if (lstat.isSymbolicLink()) {
    fs.unlinkSync(dbgraphDir);
    return;
  }

  if (!lstat.isDirectory()) {
    fs.unlinkSync(dbgraphDir);
    return;
  }

  fs.rmSync(dbgraphDir, { recursive: true, force: true });
}

/**
 * Validate the .dbgraph directory structure
 */
export function validateDirectory(projectRoot: string): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];
  const dbgraphDir = getDBGraphDir(projectRoot);

  if (!fs.existsSync(dbgraphDir)) {
    errors.push('DBGraph directory does not exist');
    return { valid: false, errors };
  }

  if (!fs.statSync(dbgraphDir).isDirectory()) {
    errors.push('.dbgraph exists but is not a directory');
    return { valid: false, errors };
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

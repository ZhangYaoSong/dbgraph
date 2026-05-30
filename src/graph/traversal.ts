/**
 * Graph Traversal Algorithms
 *
 * BFS and DFS traversal for the database schema knowledge graph.
 * Operates on nodes/edges stored in SQLite via QueryBuilder.
 *
 * All traversal methods use batch node lookups (getNodesByIds) to avoid
 * N+1 query patterns and maintain performance on large schemas.
 */

import { Node, NodeKind, Edge, Subgraph, TraversalOptions, EdgeKind } from '../types';
import { QueryBuilder } from '../db/queries';

/**
 * Default traversal options
 */
const DEFAULT_OPTIONS: Required<TraversalOptions> = {
  maxDepth: Infinity,
  edgeKinds: [],
  nodeKinds: [],
  direction: 'outgoing',
  limit: 1000,
  includeStart: true,
};

/**
 * Result of a single traversal step
 */
interface TraversalStep {
  node: Node;
  edge: Edge | null;
  depth: number;
}

/**
 * Graph traverser for BFS and DFS traversal of the database schema graph.
 *
 * Provides methods to navigate the graph structure — containment hierarchies,
 * foreign-key references, and impact analysis — all with batched queries.
 */
export class GraphTraverser {
  private queries: QueryBuilder;

  constructor(queries: QueryBuilder) {
    this.queries = queries;
  }

  // ===========================================================================
  // Core Traversal
  // ===========================================================================

  /**
   * Traverse the graph using breadth-first search.
   *
   * Structural edges (`contains`) are visited before reference edges so that
   * BFS discovers internal structure first before fanning out.
   *
   * @param startId - Starting node ID
   * @param options - Traversal options
   * @returns Subgraph containing traversed nodes and edges
   */
  traverseBFS(startId: string, options: TraversalOptions = {}): Subgraph {
    const opts = { ...DEFAULT_OPTIONS, ...options };
    const startNode = this.queries.getNodeById(startId);

    if (!startNode) {
      return { nodes: new Map(), edges: [], roots: [] };
    }

    const nodes = new Map<string, Node>();
    const edges: Edge[] = [];
    const visited = new Set<string>();
    const queue: TraversalStep[] = [{ node: startNode, edge: null, depth: 0 }];

    if (opts.includeStart) {
      nodes.set(startNode.id, startNode);
    }

    while (queue.length > 0 && nodes.size < opts.limit) {
      const step = queue.shift()!;
      const { node, edge, depth } = step;

      if (visited.has(node.id)) {
        continue;
      }
      visited.add(node.id);

      // Add edge to result
      if (edge) {
        edges.push(edge);
      }

      // Check depth limit
      if (depth >= opts.maxDepth) {
        continue;
      }

      // Get adjacent edges, prioritizing containment edges
      const adjacentEdges = this.getAdjacentEdges(node.id, opts.direction, opts.edgeKinds);
      adjacentEdges.sort((a, b) => {
        const priority = (e: Edge) => e.kind === 'contains' ? 0 : 1;
        return priority(a) - priority(b);
      });

      // Batch-fetch the unvisited neighbors in one query
      const wantIds = adjacentEdges
        .map((e) => (e.source === node.id ? e.target : e.source))
        .filter((id) => !visited.has(id));
      const neighborNodes = wantIds.length > 0 ? this.queries.getNodesByIds(wantIds) : new Map();

      for (const adjEdge of adjacentEdges) {
        const nextNodeId = adjEdge.source === node.id ? adjEdge.target : adjEdge.source;
        if (visited.has(nextNodeId)) continue;

        const nextNode = neighborNodes.get(nextNodeId);
        if (!nextNode) continue;

        if (opts.nodeKinds && opts.nodeKinds.length > 0 && !opts.nodeKinds.includes(nextNode.kind)) {
          continue;
        }

        nodes.set(nextNode.id, nextNode);
        queue.push({ node: nextNode, edge: adjEdge, depth: depth + 1 });
      }
    }

    return {
      nodes,
      edges,
      roots: [startId],
    };
  }

  /**
   * Traverse the graph using depth-first search.
   *
   * @param startId - Starting node ID
   * @param options - Traversal options
   * @returns Subgraph containing traversed nodes and edges
   */
  traverseDFS(startId: string, options: TraversalOptions = {}): Subgraph {
    const opts = { ...DEFAULT_OPTIONS, ...options };
    const startNode = this.queries.getNodeById(startId);

    if (!startNode) {
      return { nodes: new Map(), edges: [], roots: [] };
    }

    const nodes = new Map<string, Node>();
    const edges: Edge[] = [];
    const visited = new Set<string>();

    if (opts.includeStart) {
      nodes.set(startNode.id, startNode);
    }

    this.dfsRecursive(startNode, 0, opts, nodes, edges, visited);

    return {
      nodes,
      edges,
      roots: [startId],
    };
  }

  /**
   * Recursive DFS helper with batch neighbor fetching.
   */
  private dfsRecursive(
    node: Node,
    depth: number,
    opts: Required<TraversalOptions>,
    nodes: Map<string, Node>,
    edges: Edge[],
    visited: Set<string>,
  ): void {
    if (visited.has(node.id) || nodes.size >= opts.limit || depth >= opts.maxDepth) {
      return;
    }

    visited.add(node.id);

    // Get adjacent edges
    const adjacentEdges = this.getAdjacentEdges(node.id, opts.direction, opts.edgeKinds);

    // Batch-fetch unvisited neighbors
    const wantIds = adjacentEdges
      .map((e) => (e.source === node.id ? e.target : e.source))
      .filter((id) => !visited.has(id));
    const neighborNodes = wantIds.length > 0 ? this.queries.getNodesByIds(wantIds) : new Map();

    for (const adjEdge of adjacentEdges) {
      const nextNodeId = adjEdge.source === node.id ? adjEdge.target : adjEdge.source;
      if (visited.has(nextNodeId)) continue;

      const nextNode = neighborNodes.get(nextNodeId);
      if (!nextNode) continue;

      // Apply node kind filter
      if (opts.nodeKinds && opts.nodeKinds.length > 0 && !opts.nodeKinds.includes(nextNode.kind)) {
        continue;
      }

      nodes.set(nextNode.id, nextNode);
      edges.push(adjEdge);

      this.dfsRecursive(nextNode, depth + 1, opts, nodes, edges, visited);
    }
  }

  /**
   * Get adjacent edges based on direction.
   */
  private getAdjacentEdges(
    nodeId: string,
    direction: 'outgoing' | 'incoming' | 'both',
    edgeKinds?: EdgeKind[],
  ): Edge[] {
    const kinds = edgeKinds && edgeKinds.length > 0 ? edgeKinds : undefined;

    if (direction === 'outgoing') {
      return this.queries.getOutgoingEdges(nodeId, kinds);
    } else if (direction === 'incoming') {
      return this.queries.getIncomingEdges(nodeId, kinds);
    } else {
      const outgoing = this.queries.getOutgoingEdges(nodeId, kinds);
      const incoming = this.queries.getIncomingEdges(nodeId, kinds);
      return [...outgoing, ...incoming];
    }
  }

  // ===========================================================================
  // Reference Analysis
  // ===========================================================================

  /**
   * Find all nodes that reference a given node (e.g., tables with foreign keys
   * pointing to this table, or views referencing this table).
   *
   * Follows `references` edges incoming to the target.
   *
   * @param nodeId - ID of the node being referenced
   * @param maxDepth - Maximum depth to traverse (default: 1)
   * @returns Array of { caller node, edge } pairs
   */
  getCallers(nodeId: string, maxDepth: number = 1): Array<{ node: Node; edge: Edge }> {
    const result: Array<{ node: Node; edge: Edge }> = [];
    const visited = new Set<string>();

    this.getCallersRecursive(nodeId, maxDepth, 0, result, visited);

    return result;
  }

  private getCallersRecursive(
    nodeId: string,
    maxDepth: number,
    currentDepth: number,
    result: Array<{ node: Node; edge: Edge }>,
    visited: Set<string>,
  ): void {
    if (currentDepth >= maxDepth || visited.has(nodeId)) {
      return;
    }
    visited.add(nodeId);

    const incomingEdges = this.queries.getIncomingEdges(nodeId, ['references', 'foreign_key', 'depends_on', 'imports']);
    if (incomingEdges.length === 0) return;

    // Batch-fetch all source nodes in one round-trip
    const sourceIds = incomingEdges.map((e) => e.source);
    const callerNodes = this.queries.getNodesByIds(sourceIds);

    for (const edge of incomingEdges) {
      const callerNode = callerNodes.get(edge.source);
      if (callerNode && !visited.has(callerNode.id)) {
        result.push({ node: callerNode, edge });
        this.getCallersRecursive(callerNode.id, maxDepth, currentDepth + 1, result, visited);
      }
    }
  }

  /**
   * Find all nodes referenced by a given node (e.g., tables this foreign key
   * points to, tables this view depends on).
   *
   * Follows `references` edges outgoing from the source.
   *
   * @param nodeId - ID of the source node
   * @param maxDepth - Maximum depth to traverse (default: 1)
   * @returns Array of { callee node, edge } pairs
   */
  getCallees(nodeId: string, maxDepth: number = 1): Array<{ node: Node; edge: Edge }> {
    const result: Array<{ node: Node; edge: Edge }> = [];
    const visited = new Set<string>();

    this.getCalleesRecursive(nodeId, maxDepth, 0, result, visited);

    return result;
  }

  private getCalleesRecursive(
    nodeId: string,
    maxDepth: number,
    currentDepth: number,
    result: Array<{ node: Node; edge: Edge }>,
    visited: Set<string>,
  ): void {
    if (currentDepth >= maxDepth || visited.has(nodeId)) {
      return;
    }
    visited.add(nodeId);

    const outgoingEdges = this.queries.getOutgoingEdges(nodeId, ['references', 'foreign_key', 'depends_on', 'imports']);
    if (outgoingEdges.length === 0) return;

    // Batch-fetch all target nodes
    const targetIds = outgoingEdges.map((e) => e.target);
    const calleeNodes = this.queries.getNodesByIds(targetIds);

    for (const edge of outgoingEdges) {
      const calleeNode = calleeNodes.get(edge.target);
      if (calleeNode && !visited.has(calleeNode.id)) {
        result.push({ node: calleeNode, edge });
        this.getCalleesRecursive(calleeNode.id, maxDepth, currentDepth + 1, result, visited);
      }
    }
  }

  // ===========================================================================
  // Usage & Impact
  // ===========================================================================

  /**
   * Find all usages of a node — all incoming edges regardless of kind.
   *
   * This returns every node that has any edge pointing to the given node,
   * including foreign key references, dependencies, and structural containment.
   *
   * @param nodeId - ID of the node being examined
   * @returns Array of { using node, edge } pairs
   */
  findUsages(nodeId: string): Array<{ node: Node; edge: Edge }> {
    const result: Array<{ node: Node; edge: Edge }> = [];

    const incomingEdges = this.queries.getIncomingEdges(nodeId);
    if (incomingEdges.length === 0) return result;

    // Batch-fetch all source nodes
    const sources = this.queries.getNodesByIds(incomingEdges.map((e) => e.source));
    for (const edge of incomingEdges) {
      const sourceNode = sources.get(edge.source);
      if (sourceNode) result.push({ node: sourceNode, edge });
    }

    return result;
  }

  /**
   * Compute the impact radius of a node — all nodes that could be affected
   * if this schema object changes.
   *
   * Traverses incoming edges (dependents), including following `contains`
   * edges into container children (e.g., a column change impacts the table's
   * foreign-key dependents).
   *
   * @param nodeId - ID of the node being changed
   * @param maxDepth - Maximum depth to traverse (default: 3)
   * @returns Subgraph containing potentially impacted nodes
   */
  getImpactRadius(nodeId: string, maxDepth: number = 3): Subgraph {
    const focalNode = this.queries.getNodeById(nodeId);

    if (!focalNode) {
      return { nodes: new Map(), edges: [], roots: [] };
    }

    const nodes = new Map<string, Node>();
    const edges: Edge[] = [];
    const visited = new Set<string>();

    nodes.set(focalNode.id, focalNode);

    this.getImpactRecursive(nodeId, maxDepth, 0, nodes, edges, visited);

    return {
      nodes,
      edges,
      roots: [nodeId],
    };
  }

  /**
   * Recursive impact traversal — follows incoming edges and also descends
   * into container children (e.g., table → columns → FK references).
   */
  private getImpactRecursive(
    nodeId: string,
    maxDepth: number,
    currentDepth: number,
    nodes: Map<string, Node>,
    edges: Edge[],
    visited: Set<string>,
  ): void {
    if (currentDepth >= maxDepth || visited.has(nodeId)) {
      return;
    }
    visited.add(nodeId);

    // For container nodes (tables, views, schemas), also traverse into their
    // children so that dependents of contained members are discovered
    const focalNode = this.queries.getNodeById(nodeId);
    if (focalNode) {
      const containerKinds = new Set<NodeKind>(['table', 'view', 'schema', 'database']);
      if (containerKinds.has(focalNode.kind)) {
        const containsEdges = this.queries.getOutgoingEdges(nodeId, ['contains']);
        if (containsEdges.length > 0) {
          const children = this.queries.getNodesByIds(containsEdges.map((e) => e.target));
          for (const edge of containsEdges) {
            const childNode = children.get(edge.target);
            if (childNode && !visited.has(childNode.id)) {
              nodes.set(childNode.id, childNode);
              edges.push(edge);
              // Recurse into children at the same depth
              this.getImpactRecursive(childNode.id, maxDepth, currentDepth, nodes, edges, visited);
            }
          }
        }
      }
    }

    // Get all incoming edges (things that depend on this node)
    const incomingEdges = this.queries.getIncomingEdges(nodeId);
    if (incomingEdges.length === 0) return;

    const sources = this.queries.getNodesByIds(incomingEdges.map((e) => e.source));

    for (const edge of incomingEdges) {
      const sourceNode = sources.get(edge.source);
      if (sourceNode && !nodes.has(sourceNode.id)) {
        nodes.set(sourceNode.id, sourceNode);
        edges.push(edge);
        this.getImpactRecursive(sourceNode.id, maxDepth, currentDepth + 1, nodes, edges, visited);
      }
    }
  }

  // ===========================================================================
  // Path Finding
  // ===========================================================================

  /**
   * Find the shortest path between two nodes using bidirectional BFS.
   *
   * Each step follows outgoing edges from the direction being expanded.
   * Returns the path as an ordered array of { node, edge } steps, where
   * the first entry's `edge` is null (the start node has no incoming edge).
   *
   * @param fromId - Starting node ID
   * @param toId - Target node ID
   * @param edgeKinds - Edge types to consider (all if empty array)
   * @returns Ordered path, or null if no path exists
   */
  findPath(
    fromId: string,
    toId: string,
    edgeKinds: EdgeKind[] = [],
  ): Array<{ node: Node; edge: Edge | null }> | null {
    const fromNode = this.queries.getNodeById(fromId);
    const toNode = this.queries.getNodeById(toId);

    if (!fromNode || !toNode) {
      return null;
    }

    // Short-circuit: same node
    if (fromId === toId) {
      return [{ node: fromNode, edge: null }];
    }

    // Bidirectional BFS
    const kinds = edgeKinds.length > 0 ? edgeKinds : undefined;

    const forwardVisited = new Map<string, Array<{ node: Node; edge: Edge | null }>>();
    const backwardVisited = new Map<string, Array<{ node: Node; edge: Edge | null }>>();

    forwardVisited.set(fromId, [{ node: fromNode, edge: null }]);
    backwardVisited.set(toId, [{ node: toNode, edge: null }]);

    const forwardQueue: string[] = [fromId];
    const backwardQueue: string[] = [toId];

    while (forwardQueue.length > 0 && backwardQueue.length > 0) {
      // Expand forward frontier
      const meetPoint = this.expandPathFrontier(
        forwardQueue, forwardVisited, backwardVisited, 'outgoing', kinds,
      );
      if (meetPoint !== null) {
        return this.mergePaths(forwardVisited, backwardVisited, meetPoint);
      }

      // Expand backward frontier
      const meetPoint2 = this.expandPathFrontier(
        backwardQueue, backwardVisited, forwardVisited, 'incoming', kinds,
      );
      if (meetPoint2 !== null) {
        return this.mergePaths(backwardVisited, forwardVisited, meetPoint2);
      }
    }

    return null; // No path found
  }

  /**
   * Expand one frontier of the bidirectional BFS by one layer.
   *
   * Returns the meeting node ID if frontiers intersect, or null otherwise.
   */
  private expandPathFrontier(
    queue: string[],
    currentVisited: Map<string, Array<{ node: Node; edge: Edge | null }>>,
    otherVisited: Map<string, Array<{ node: Node; edge: Edge | null }>>,
    direction: 'outgoing' | 'incoming',
    edgeKinds?: EdgeKind[],
  ): string | null {
    const batch: string[] = [];

    // Drain current queue into a batch so new pushes don't re-process
    while (queue.length > 0) {
      batch.push(queue.shift()!);
    }

    // Collect all edges and targets for the batch
    const adjacencyMap = new Map<string, Array<{ nextId: string; edge: Edge }>>();

    for (const nodeId of batch) {
      const edges = direction === 'outgoing'
        ? this.queries.getOutgoingEdges(nodeId, edgeKinds)
        : this.queries.getIncomingEdges(nodeId, edgeKinds);

      for (const edge of edges) {
        const nextId = direction === 'outgoing' ? edge.target : edge.source;
        if (!adjacencyMap.has(nodeId)) adjacencyMap.set(nodeId, []);
        adjacencyMap.get(nodeId)!.push({ nextId, edge });
      }
    }

    // Collect all candidate next IDs for batch fetch
    const allCandidateIds = new Set<string>();
    for (const entries of adjacencyMap.values()) {
      for (const { nextId } of entries) {
        allCandidateIds.add(nextId);
      }
    }

    // Filter to unvisited and batch-fetch
    const wantIds = [...allCandidateIds].filter((id) => !currentVisited.has(id));
    const fetchedNodes = wantIds.length > 0 ? this.queries.getNodesByIds(wantIds) : new Map();

    for (const nodeId of batch) {
      const entries = adjacencyMap.get(nodeId);
      if (!entries) continue;

      const currentPath = currentVisited.get(nodeId)!;

      for (const { nextId, edge } of entries) {
        if (currentVisited.has(nextId)) continue;

        const nextNode = fetchedNodes.get(nextId);
        if (!nextNode) continue;

        const newPath = [...currentPath, { node: nextNode, edge }];
        currentVisited.set(nextId, newPath);
        queue.push(nextId);

        // Check for intersection
        if (otherVisited.has(nextId)) {
          return nextId;
        }
      }
    }

    return null;
  }

  /**
   * Merge forward and backward path fragments at the meeting node.
   */
  private mergePaths(
    forward: Map<string, Array<{ node: Node; edge: Edge | null }>>,
    backward: Map<string, Array<{ node: Node; edge: Edge | null }>>,
    meetPoint: string,
  ): Array<{ node: Node; edge: Edge | null }> {
    const forwardPath = forward.get(meetPoint)!;
    const backwardPath = backward.get(meetPoint)!;

    // Backward path is stored from meet → target; reverse and drop the
    // duplicate meet-point node (keep only the forward copy's edge = null head)
    const reversedBackward = backwardPath.slice(1).reverse();

    return [...forwardPath, ...reversedBackward];
  }

  // ===========================================================================
  // Hierarchy
  // ===========================================================================

  /**
   * Walk up the containment hierarchy from a node to its ancestors.
   *
   * Follows `contains` edges in reverse (incoming edges of kind `contains`),
   * which represent "parent → child" — so the incoming edge on this node
   * points to its parent.
   *
   * @param nodeId - ID of the node to start from
   * @returns Array of ancestor nodes from immediate parent to root
   */
  getAncestors(nodeId: string): Node[] {
    const ancestors: Node[] = [];
    const visited = new Set<string>();
    let currentId = nodeId;

    while (true) {
      if (visited.has(currentId)) {
        break;
      }
      visited.add(currentId);

      // Look for 'contains' edges pointing to this node (it's a child)
      const containingEdges = this.queries.getIncomingEdges(currentId, ['contains']);

      const firstEdge = containingEdges[0];
      if (!firstEdge) {
        break;
      }

      // A node typically has at most one containing parent
      const parentNode = this.queries.getNodeById(firstEdge.source);
      if (parentNode) {
        ancestors.push(parentNode);
        currentId = parentNode.id;
      } else {
        break;
      }
    }

    return ancestors;
  }

  /**
   * Get immediate children of a node via `contains` outgoing edges.
   *
   * For a table, these would be its columns, indexes, constraints, etc.
   * For a schema, these would be its tables and views.
   *
   * @param nodeId - ID of the parent node
   * @returns Array of child nodes
   */
  getChildren(nodeId: string): Node[] {
    const containsEdges = this.queries.getOutgoingEdges(nodeId, ['contains']);
    if (containsEdges.length === 0) return [];

    // Batch-fetch all children
    const childNodes = this.queries.getNodesByIds(containsEdges.map((e) => e.target));
    const children: Node[] = [];
    for (const edge of containsEdges) {
      const childNode = childNodes.get(edge.target);
      if (childNode) children.push(childNode);
    }
    return children;
  }
}

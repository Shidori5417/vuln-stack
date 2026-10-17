import { describe, expect, it } from 'vitest';
import {
  addEdge,
  addNode,
  chainNames,
  computePaths,
  createGraph,
  ROOT_ID,
} from '../src/model/graph.js';
import type { Dependency } from '../src/model/types.js';

const dep = (name: string, version = '1.0.0', extra: Partial<Dependency> = {}): Dependency => ({
  ecosystem: 'npm',
  name,
  version,
  isDirect: false,
  sourceFile: 'package-lock.json',
  confidence: 'high',
  ...extra,
});

describe('graph', () => {
  it('merges duplicate nodes, keeping direct and prod flags', () => {
    const g = createGraph('app');
    addNode(g, dep('a', '1.0.0', { scope: 'dev' }));
    addNode(g, dep('a', '1.0.0', { isDirect: true, scope: 'prod' }));
    expect(g.nodes.size).toBe(1);
    expect(g.nodes.get('a@1.0.0')).toMatchObject({ isDirect: true, scope: 'prod' });
  });

  it('ignores self edges', () => {
    const g = createGraph('app');
    addEdge(g, 'a@1', 'a@1');
    expect(g.edges.size).toBe(0);
  });

  it('finds shortest chains and counts shortest paths, surviving cycles', () => {
    const g = createGraph('my-app');
    for (const n of ['express', 'body-parser', 'qs', 'koa', 'orphan']) addNode(g, dep(n));
    addEdge(g, ROOT_ID, 'express@1.0.0');
    addEdge(g, ROOT_ID, 'koa@1.0.0');
    addEdge(g, 'express@1.0.0', 'body-parser@1.0.0');
    addEdge(g, 'koa@1.0.0', 'body-parser@1.0.0');
    addEdge(g, 'body-parser@1.0.0', 'qs@1.0.0');
    addEdge(g, 'qs@1.0.0', 'express@1.0.0'); // cycle

    const paths = computePaths(g);
    expect(paths.get('qs@1.0.0')!.path).toEqual(['express@1.0.0', 'body-parser@1.0.0', 'qs@1.0.0']);
    expect(paths.get('body-parser@1.0.0')!.pathCount).toBe(2);
    expect(paths.get('qs@1.0.0')!.pathCount).toBe(2);
    expect(paths.get('orphan@1.0.0')!.path).toEqual(['orphan@1.0.0']);
    expect(chainNames(g, paths.get('qs@1.0.0')!.path)).toEqual([
      'my-app',
      'express',
      'body-parser',
      'qs',
    ]);
    expect(chainNames(g, ['ghost@1'])).toEqual(['my-app', 'ghost@1']);
  });
});

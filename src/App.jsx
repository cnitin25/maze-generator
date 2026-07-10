import { useState, useRef, useEffect, useMemo } from "react";

/**
 * MazeGenerator
 * -------------
 * Generates a "perfect" maze (a spanning tree over a grid graph — every cell
 * reachable, exactly one path between any two cells, no loops) using a
 * randomized recursive backtracker, then:
 *   1. Runs a double-BFS to pick a start/end pair that maximizes the solution
 *      path length (rather than a naive random pick, which often produces
 *      short/boring solutions). This is exact when the graph is still a tree
 *      (the classic double-sweep-BFS diameter result), but loops are added
 *      *before* this step runs (see below), so for any difficulty with
 *      loopRate > 0 it's a strong heuristic rather than a proven-longest pair.
 *   2. Optionally removes a handful of extra walls ("loop rate") to add
 *      genuine false branches for harder difficulties, without ever
 *      breaking solvability or creating disconnected regions.
 *
 * This intentionally does NOT build a solution path first and scatter fake
 * walls around it — that approach risks ambiguous/multiple solutions and
 * unnatural-looking mazes. Instead the maze *is* a spanning tree, and the
 * solution path is derived from it afterwards.
 *
 * Circular ("Theta") mazes use a polar grid instead (rings x angular
 * sectors, with cw/ccw neighbors wrapping around each ring and inward/
 * outward neighbors connecting rings) — see buildPolarGrid/carvePolarMaze/
 * drawPolarMaze below. Same backtracker/double-BFS/loop-adding algorithms,
 * just walking a different adjacency shape, so it has its own parallel set
 * of functions rather than a shared abstraction forced onto both shapes.
 *
 * Seeding: all randomness flows through a single mulberry32 PRNG seeded by
 * hashing a user-facing seed string. Same seed + same difficulty + same
 * shape always reproduces an identical maze, since the double-BFS start/end
 * selection is itself deterministic given the carved grid (no additional
 * randomness there).
 *
 * Solution verification: generateMaze/generatePolarMaze compute
 * stats.uniqueSolution by actually testing the S/E pair — remove the found
 * solution's edges from the graph and re-run BFS from start; if end is
 * still reachable, an alternate route exists. This is exact for that
 * specific start/end pair, not just an inference from the loop count (a
 * maze can have loops elsewhere in the graph that don't affect this
 * particular pair).
 *
 * Wiring to a backend: if you want server-side generation (e.g. to persist
 * a maze by id/seed, or run heavier arbitrary-shape masks), replace the
 * generate() call with a fetch to something like POST /api/maze and keep
 * the render/draw logic as-is — it only needs { grid, cols, rows, start,
 * end, solutionPath }.
 */

const DIRS = [
  { name: "N", dr: -1, dc: 0, opposite: "S" },
  { name: "S", dr: 1, dc: 0, opposite: "N" },
  { name: "E", dr: 0, dc: 1, opposite: "W" },
  { name: "W", dr: 0, dc: -1, opposite: "E" },
];

const DIFFICULTY_PRESETS = {
  easy: { label: "Easy", rect: [14, 10], square: [11, 11], circular: 6, loopRate: 0 },
  medium: { label: "Medium", rect: [20, 14], square: [16, 16], circular: 9, loopRate: 0.03 },
  hard: { label: "Hard", rect: [28, 19], square: [22, 22], circular: 13, loopRate: 0.06 },
};

const COLORS = {
  panelBg: "#f3f5ed",
  canvasBg: "#f6f8fa",
  dot: "rgba(3, 28, 47, 0.98)",
  wall: "#33414d",
  thread: "#6FCF97",
  start: "#F2B84B",
  end: "#3B82C4",
  text: "#20303f",
  textMuted: "#8FA9C2",
  border: "rgba(1, 10, 17, 0.97)",
};

// ---------------------------------------------------------------------------
// Seeded randomness
// ---------------------------------------------------------------------------

// mulberry32: small, fast, well-distributed PRNG. `a` is a 32-bit int seed.
function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Hashes an arbitrary string seed down to a 32-bit int (xmur3-style), so
// people can type memorable seeds ("lotus-42") rather than raw numbers.
function hashSeed(str) {
  let h = 0xdeadbeef ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 2654435761);
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  h ^= h >>> 16;
  return h >>> 0;
}

function generateRandomSeedString() {
  return Math.random().toString(36).slice(2, 10);
}

// ---------------------------------------------------------------------------
// Rectangular / square grid maze
// ---------------------------------------------------------------------------

function buildGrid(cols, rows) {
  const grid = [];
  for (let r = 0; r < rows; r++) {
    const row = [];
    for (let c = 0; c < cols; c++) {
      row.push({ N: true, E: true, S: true, W: true, visited: false });
    }
    grid.push(row);
  }
  return grid;
}

function carveMaze(cols, rows, rng) {
  const grid = buildGrid(cols, rows);
  const stack = [[0, 0]];
  grid[0][0].visited = true;

  while (stack.length) {
    const [r, c] = stack[stack.length - 1];
    const options = DIRS.filter((d) => {
      const nr = r + d.dr;
      const nc = c + d.dc;
      return nr >= 0 && nr < rows && nc >= 0 && nc < cols && !grid[nr][nc].visited;
    });

    if (options.length === 0) {
      stack.pop();
      continue;
    }

    const dir = options[Math.floor(rng() * options.length)];
    const nr = r + dir.dr;
    const nc = c + dir.dc;
    grid[r][c][dir.name] = false;
    grid[nr][nc][dir.opposite] = false;
    grid[nr][nc].visited = true;
    stack.push([nr, nc]);
  }

  return grid;
}

function addLoops(grid, cols, rows, loopRate, rng) {
  if (loopRate <= 0) return 0;
  let added = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      for (const dir of [DIRS[1], DIRS[2]]) {
        const nr = r + dir.dr;
        const nc = c + dir.dc;
        if (nr < rows && nc < cols && grid[r][c][dir.name] && rng() < loopRate) {
          grid[r][c][dir.name] = false;
          grid[nr][nc][dir.opposite] = false;
          added += 1;
        }
      }
    }
  }
  return added;
}

function bfs(grid, start, cols, rows) {
  const key = (r, c) => r * cols + c;
  const dist = new Map([[key(start[0], start[1]), 0]]);
  const parent = new Map();
  const queue = [start];
  let head = 0;
  let farthest = start;

  while (head < queue.length) {
    const [r, c] = queue[head++];
    const d = dist.get(key(r, c));
    if (d > dist.get(key(farthest[0], farthest[1]))) farthest = [r, c];

    for (const dir of DIRS) {
      if (!grid[r][c][dir.name]) {
        const nr = r + dir.dr;
        const nc = c + dir.dc;
        if (nr >= 0 && nr < rows && nc >= 0 && nc < cols && !dist.has(key(nr, nc))) {
          dist.set(key(nr, nc), d + 1);
          parent.set(key(nr, nc), [r, c]);
          queue.push([nr, nc]);
        }
      }
    }
  }
  return { dist, parent, farthest };
}

function pathBetween(parent, start, end, cols) {
  const key = (r, c) => r * cols + c;
  const path = [end];
  let cur = end;
  while (cur[0] !== start[0] || cur[1] !== start[1]) {
    cur = parent.get(key(cur[0], cur[1]));
    path.push(cur);
  }
  return path.reverse();
}

function edgeKeyGrid(r1, c1, r2, c2, cols) {
  const k1 = r1 * cols + c1;
  const k2 = r2 * cols + c2;
  return k1 < k2 ? `${k1}_${k2}` : `${k2}_${k1}`;
}

// Exact check for THIS start/end pair: strip the found solution's edges out
// of the graph, then see if end is still reachable from start. If it is,
// a genuinely different route exists between these two specific points.
function verifyGridSolution(grid, cols, rows, start, end, solutionPath) {
  const solutionEdges = new Set();
  for (let i = 0; i < solutionPath.length - 1; i++) {
    const [r1, c1] = solutionPath[i];
    const [r2, c2] = solutionPath[i + 1];
    solutionEdges.add(edgeKeyGrid(r1, c1, r2, c2, cols));
  }

  const startKey = start[0] * cols + start[1];
  const endKey = end[0] * cols + end[1];
  const visited = new Set([startKey]);
  const queue = [start];
  let head = 0;

  while (head < queue.length) {
    const [r, c] = queue[head++];
    for (const dir of DIRS) {
      if (grid[r][c][dir.name]) continue;
      const nr = r + dir.dr;
      const nc = c + dir.dc;
      if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) continue;
      if (solutionEdges.has(edgeKeyGrid(r, c, nr, nc, cols))) continue;
      const nk = nr * cols + nc;
      if (!visited.has(nk)) {
        visited.add(nk);
        queue.push([nr, nc]);
      }
    }
  }

  return !visited.has(endKey);
}

// Derives every stat straight from the grid's actual wall state — never
// trusted from elsewhere — so it gives the same answer whether called right
// after generation or after reconstructing a grid from an imported file.
// `loopsAdded` comes from edge-counting (open edges beyond a spanning tree's
// cols*rows-1) rather than tracking addLoops' return value, so it stays
// correct even for a hand-edited/imported grid that was never run through
// addLoops at all.
function computeGridStats(grid, cols, rows, solutionPath, uniqueSolution) {
  let deadEnds = 0;
  let openEdges = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const openings = ["N", "E", "S", "W"].filter((k) => !grid[r][c][k]).length;
      if (openings === 1) deadEnds += 1;
      openEdges += openings;
    }
  }
  openEdges /= 2;

  return {
    cells: cols * rows,
    solutionLength: solutionPath.length,
    deadEnds,
    loopsAdded: openEdges - (cols * rows - 1),
    uniqueSolution,
  };
}

function generateMaze(cols, rows, loopRate, rng) {
  const grid = carveMaze(cols, rows, rng);
  addLoops(grid, cols, rows, loopRate, rng);

  const first = bfs(grid, [0, 0], cols, rows);
  const start = first.farthest;
  const second = bfs(grid, start, cols, rows);
  const end = second.farthest;
  const solutionPath = pathBetween(second.parent, start, end, cols);
  const uniqueSolution = verifyGridSolution(grid, cols, rows, start, end, solutionPath);

  return {
    kind: "grid",
    grid,
    cols,
    rows,
    start,
    end,
    solutionPath,
    stats: computeGridStats(grid, cols, rows, solutionPath, uniqueSolution),
  };
}

// ---------------------------------------------------------------------------
// Circular ("Theta") maze — polar grid of concentric rings
// ---------------------------------------------------------------------------

function buildPolarGrid(rings) {
  const grid = [
    [{ ring: 0, idx: 0, cw: null, ccw: null, inward: null, outward: [], visited: false, links: new Set() }],
  ];
  const ringHeight = 1 / rings;

  for (let i = 1; i < rings; i++) {
    const radius = i / rings;
    const circumference = 2 * Math.PI * radius;
    const prevCount = grid[i - 1].length;
    const estimatedCellWidth = circumference / prevCount;
    const ratio = Math.round(estimatedCellWidth / ringHeight) || 1;
    const cellCount = prevCount * ratio;
    const ring = [];
    for (let j = 0; j < cellCount; j++) {
      ring.push({ ring: i, idx: j, cw: null, ccw: null, inward: null, outward: [], visited: false, links: new Set() });
    }
    grid.push(ring);
  }

  for (let i = 0; i < grid.length; i++) {
    const ring = grid[i];
    const n = ring.length;
    for (let j = 0; j < n; j++) {
      const cell = ring[j];
      if (n > 1) {
        cell.cw = ring[(j + 1) % n];
        cell.ccw = ring[(j - 1 + n) % n];
      }
      if (i > 0) {
        const prevRing = grid[i - 1];
        const ratio = n / prevRing.length;
        const parent = prevRing[Math.floor(j / ratio)];
        cell.inward = parent;
        parent.outward.push(cell);
      }
    }
  }

  return grid;
}

function carvePolarMaze(grid, rng) {
  const start = grid[0][0];
  start.visited = true;
  const stack = [start];

  while (stack.length) {
    const cell = stack[stack.length - 1];
    const options = [...new Set([cell.cw, cell.ccw, cell.inward, ...cell.outward])].filter(
      (n) => n && !n.visited
    );

    if (options.length === 0) {
      stack.pop();
      continue;
    }

    const next = options[Math.floor(rng() * options.length)];
    cell.links.add(next);
    next.links.add(cell);
    next.visited = true;
    stack.push(next);
  }
}

function addLoopsPolar(grid, loopRate, rng) {
  if (loopRate <= 0) return 0;
  let added = 0;
  for (const ring of grid) {
    for (const cell of ring) {
      for (const neighbor of [cell.cw, ...cell.outward]) {
        if (neighbor && !cell.links.has(neighbor) && rng() < loopRate) {
          cell.links.add(neighbor);
          neighbor.links.add(cell);
          added += 1;
        }
      }
    }
  }
  return added;
}

function bfsPolar(startCell) {
  const dist = new Map([[startCell, 0]]);
  const parent = new Map();
  const queue = [startCell];
  let head = 0;
  let farthest = startCell;

  while (head < queue.length) {
    const cell = queue[head++];
    const d = dist.get(cell);
    if (d > dist.get(farthest)) farthest = cell;

    for (const neighbor of cell.links) {
      if (!dist.has(neighbor)) {
        dist.set(neighbor, d + 1);
        parent.set(neighbor, cell);
        queue.push(neighbor);
      }
    }
  }
  return { dist, parent, farthest };
}

function pathBetweenPolar(parent, start, end) {
  const path = [end];
  let cur = end;
  while (cur !== start) {
    cur = parent.get(cur);
    path.push(cur);
  }
  return path.reverse();
}

function polarCellKey(cell) {
  return `${cell.ring}_${cell.idx}`;
}

function edgeKeyPolar(a, b) {
  const ka = polarCellKey(a);
  const kb = polarCellKey(b);
  return ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
}

function verifyPolarSolution(start, end, solutionPath) {
  const solutionEdges = new Set();
  for (let i = 0; i < solutionPath.length - 1; i++) {
    solutionEdges.add(edgeKeyPolar(solutionPath[i], solutionPath[i + 1]));
  }

  const visited = new Set([polarCellKey(start)]);
  const queue = [start];
  let head = 0;

  while (head < queue.length) {
    const cell = queue[head++];
    for (const neighbor of cell.links) {
      if (solutionEdges.has(edgeKeyPolar(cell, neighbor))) continue;
      const nk = polarCellKey(neighbor);
      if (!visited.has(nk)) {
        visited.add(nk);
        queue.push(neighbor);
      }
    }
  }

  return !visited.has(polarCellKey(end));
}

// See computeGridStats — same principle, derived from the actual linked
// graph rather than trusted from a caller, so it's correct for both freshly
// generated and imported mazes.
function computePolarStats(grid, solutionPath, uniqueSolution) {
  const all = grid.flat();
  let deadEnds = 0;
  let totalLinks = 0;
  for (const cell of all) {
    if (cell.links.size === 1) deadEnds += 1;
    totalLinks += cell.links.size;
  }
  totalLinks /= 2;

  return {
    cells: all.length,
    solutionLength: solutionPath.length,
    deadEnds,
    loopsAdded: totalLinks - (all.length - 1),
    uniqueSolution,
  };
}

function generatePolarMaze(rings, loopRate, rng) {
  const grid = buildPolarGrid(rings);
  carvePolarMaze(grid, rng);
  addLoopsPolar(grid, loopRate, rng);

  const first = bfsPolar(grid[0][0]);
  const start = first.farthest;
  const second = bfsPolar(start);
  const end = second.farthest;
  const solutionPath = pathBetweenPolar(second.parent, start, end);
  const uniqueSolution = verifyPolarSolution(start, end, solutionPath);

  return {
    kind: "polar",
    grid,
    rings,
    start,
    end,
    solutionPath,
    stats: computePolarStats(grid, solutionPath, uniqueSolution),
  };
}

// ---------------------------------------------------------------------------
// Shared render geometry — single source of truth for the numbers used by
// BOTH the canvas draw functions and the SVG export functions below, so a
// future visual tweak can't accidentally apply to only one of the two.
// ---------------------------------------------------------------------------

function gridWallWidth(cellSize) {
  return Math.max(2, cellSize * 0.07);
}
function gridBorderWidth(cellSize) {
  return Math.max(3, cellSize * 0.1);
}
function gridMarkerGeometry(cellSize) {
  return { radius: cellSize * 0.32, font: Math.max(10, cellSize * 0.38) };
}
function gridSolutionStyle(cellSize) {
  return { width: Math.max(2, cellSize * 0.13), dash: [cellSize * 0.26, cellSize * 0.2] };
}
function gridCellPoint(r, c, cellSize) {
  return { x: c * cellSize + cellSize / 2, y: r * cellSize + cellSize / 2 };
}
function sameGridCell(a, b) {
  return a[0] === b[0] && a[1] === b[1];
}

function polarWallWidth(canvasSize) {
  return Math.max(1.5, canvasSize * 0.0035);
}
function polarMarkerGeometry(ringThickness) {
  return { radius: ringThickness * 0.4, font: Math.max(10, ringThickness * 0.45) };
}
function polarSolutionStyle(canvasSize) {
  return { width: Math.max(2, canvasSize * 0.006), dash: [canvasSize * 0.012, canvasSize * 0.01] };
}
function samePolarCell(a, b) {
  return a.ring === b.ring && a.idx === b.idx;
}

// A degenerate maze (1x1 grid, or a 1-ring circular maze) has start === end.
// Drawing two markers on top of each other just hides one, so collapse to a
// single combined marker in that case — for both grid and polar mazes.
function gridMarkers(start, end) {
  if (sameGridCell(start, end)) return [{ pos: start, color: COLORS.start, label: "S/E" }];
  return [
    { pos: start, color: COLORS.start, label: "S" },
    { pos: end, color: COLORS.end, label: "E" },
  ];
}
function polarMarkers(start, end) {
  if (samePolarCell(start, end)) return [{ cell: start, color: COLORS.start, label: "S/E" }];
  return [
    { cell: start, color: COLORS.start, label: "S" },
    { cell: end, color: COLORS.end, label: "E" },
  ];
}

function polarAngleOf(ring, idx) {
  return (idx / ring.length) * Math.PI * 2 - Math.PI / 2;
}
function polarCellCenter(grid, ringThickness, cx, cy, cell) {
  const ring = grid[cell.ring];
  const a = polarAngleOf(ring, cell.idx) + Math.PI / ring.length;
  const r = (cell.ring + 0.5) * ringThickness;
  return { x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r };
}

// ---------------------------------------------------------------------------
// Canvas rendering
// ---------------------------------------------------------------------------

function drawMarker(ctx, x, y, radius, fontSize, color, label) {
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.fillStyle = COLORS.canvasBg;
  ctx.font = `600 ${fontSize}px "JetBrains Mono", monospace`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(label, x, y + 1);
}

function drawMaze(ctx, maze, cellSize, showSolution) {
  const { grid, cols, rows, start, end, solutionPath } = maze;
  const width = cols * cellSize;
  const height = rows * cellSize;

  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = COLORS.canvasBg;
  ctx.fillRect(0, 0, width, height);

  ctx.fillStyle = COLORS.dot;
  for (let r = 0; r <= rows; r++) {
    for (let c = 0; c <= cols; c++) {
      ctx.beginPath();
      ctx.arc(c * cellSize, r * cellSize, 1, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  ctx.strokeStyle = COLORS.wall;
  ctx.lineWidth = gridWallWidth(cellSize);
  ctx.lineCap = "round";
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const cell = grid[r][c];
      const x = c * cellSize;
      const y = r * cellSize;
      ctx.beginPath();
      if (cell.N) {
        ctx.moveTo(x, y);
        ctx.lineTo(x + cellSize, y);
      }
      if (cell.W) {
        ctx.moveTo(x, y);
        ctx.lineTo(x, y + cellSize);
      }
      if (r === rows - 1 && cell.S) {
        ctx.moveTo(x, y + cellSize);
        ctx.lineTo(x + cellSize, y + cellSize);
      }
      if (c === cols - 1 && cell.E) {
        ctx.moveTo(x + cellSize, y);
        ctx.lineTo(x + cellSize, y + cellSize);
      }
      ctx.stroke();
    }
  }

  ctx.lineWidth = gridBorderWidth(cellSize);
  ctx.strokeStyle = COLORS.wall;
  ctx.strokeRect(1, 1, width - 2, height - 2);

  if (showSolution && solutionPath?.length) {
    const { width: lineWidth, dash } = gridSolutionStyle(cellSize);
    ctx.save();
    ctx.strokeStyle = COLORS.thread;
    ctx.lineWidth = lineWidth;
    ctx.setLineDash(dash);
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.beginPath();
    solutionPath.forEach(([r, c], i) => {
      const { x: cx, y: cy } = gridCellPoint(r, c, cellSize);
      if (i === 0) ctx.moveTo(cx, cy);
      else ctx.lineTo(cx, cy);
    });
    ctx.stroke();
    ctx.restore();
  }

  const { radius: markerRadius, font: markerFont } = gridMarkerGeometry(cellSize);
  for (const { pos, color, label } of gridMarkers(start, end)) {
    const { x, y } = gridCellPoint(pos[0], pos[1], cellSize);
    drawMarker(ctx, x, y, markerRadius, markerFont, color, label);
  }
}

function drawPolarMaze(ctx, maze, canvasSize, showSolution) {
  const { grid, rings, start, end, solutionPath } = maze;
  const cx = canvasSize / 2;
  const cy = canvasSize / 2;
  const maxRadius = canvasSize / 2 - canvasSize * 0.04;
  const ringThickness = maxRadius / rings;
  const cellCenter = (cell) => polarCellCenter(grid, ringThickness, cx, cy, cell);

  ctx.clearRect(0, 0, canvasSize, canvasSize);
  ctx.fillStyle = COLORS.canvasBg;
  ctx.fillRect(0, 0, canvasSize, canvasSize);

  ctx.strokeStyle = COLORS.wall;
  ctx.lineWidth = polarWallWidth(canvasSize);
  ctx.lineCap = "round";

  for (const ring of grid) {
    const innerR = ring[0].ring * ringThickness;
    const outerR = innerR + ringThickness;
    for (const cell of ring) {
      const a0 = polarAngleOf(ring, cell.idx);
      const a1 = polarAngleOf(ring, cell.idx + 1);

      if (cell.ccw && !cell.links.has(cell.ccw)) {
        ctx.beginPath();
        ctx.moveTo(cx + Math.cos(a0) * innerR, cy + Math.sin(a0) * innerR);
        ctx.lineTo(cx + Math.cos(a0) * outerR, cy + Math.sin(a0) * outerR);
        ctx.stroke();
      }

      if (cell.outward.length > 0) {
        for (const child of cell.outward) {
          if (cell.links.has(child)) continue;
          const childRing = grid[child.ring];
          ctx.beginPath();
          ctx.arc(cx, cy, outerR, polarAngleOf(childRing, child.idx), polarAngleOf(childRing, child.idx + 1));
          ctx.stroke();
        }
      } else {
        ctx.beginPath();
        ctx.arc(cx, cy, outerR, a0, a1);
        ctx.stroke();
      }
    }
  }

  if (showSolution && solutionPath?.length) {
    const { width: lineWidth, dash } = polarSolutionStyle(canvasSize);
    ctx.save();
    ctx.strokeStyle = COLORS.thread;
    ctx.lineWidth = lineWidth;
    ctx.setLineDash(dash);
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.beginPath();
    solutionPath.forEach((cell, i) => {
      const { x, y } = cellCenter(cell);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
    ctx.restore();
  }

  const { radius: markerRadius, font: markerFont } = polarMarkerGeometry(ringThickness);
  for (const { cell, color, label } of polarMarkers(start, end)) {
    const { x, y } = cellCenter(cell);
    drawMarker(ctx, x, y, markerRadius, markerFont, color, label);
  }
}

// ---------------------------------------------------------------------------
// SVG export — mirrors the canvas drawing functions above, element for
// element, so the exported file matches what's on screen.
// ---------------------------------------------------------------------------

function buildGridSVG(maze, cellSize, showSolution) {
  const { grid, cols, rows, start, end, solutionPath } = maze;
  const width = cols * cellSize;
  const height = rows * cellSize;
  const wallWidth = gridWallWidth(cellSize);
  const lines = [];

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const cell = grid[r][c];
      const x = c * cellSize;
      const y = r * cellSize;
      if (cell.N) lines.push(`<line x1="${x}" y1="${y}" x2="${x + cellSize}" y2="${y}" />`);
      if (cell.W) lines.push(`<line x1="${x}" y1="${y}" x2="${x}" y2="${y + cellSize}" />`);
      if (r === rows - 1 && cell.S)
        lines.push(`<line x1="${x}" y1="${y + cellSize}" x2="${x + cellSize}" y2="${y + cellSize}" />`);
      if (c === cols - 1 && cell.E)
        lines.push(`<line x1="${x + cellSize}" y1="${y}" x2="${x + cellSize}" y2="${y + cellSize}" />`);
    }
  }

  let solutionMarkup = "";
  if (showSolution && solutionPath?.length) {
    const { width: strokeWidth, dash } = gridSolutionStyle(cellSize);
    const points = solutionPath
      .map(([r, c]) => {
        const p = gridCellPoint(r, c, cellSize);
        return `${p.x},${p.y}`;
      })
      .join(" ");
    solutionMarkup = `<polyline points="${points}" fill="none" stroke="${COLORS.thread}" stroke-width="${strokeWidth}" stroke-dasharray="${dash[0]},${dash[1]}" stroke-linecap="round" stroke-linejoin="round" />`;
  }

  const { radius: markerRadius, font: markerFont } = gridMarkerGeometry(cellSize);
  const marker = (pos, color, label) => {
    const { x: cx, y: cy } = gridCellPoint(pos[0], pos[1], cellSize);
    return `<circle cx="${cx}" cy="${cy}" r="${markerRadius}" fill="${color}" /><text x="${cx}" y="${cy}" font-family="'JetBrains Mono', monospace" font-size="${markerFont}" font-weight="600" fill="${COLORS.canvasBg}" text-anchor="middle" dominant-baseline="central">${label}</text>`;
  };
  const markersMarkup = gridMarkers(start, end)
    .map(({ pos, color, label }) => marker(pos, color, label))
    .join("");

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    `<rect x="0" y="0" width="${width}" height="${height}" fill="${COLORS.canvasBg}" />` +
    `<g stroke="${COLORS.wall}" stroke-width="${wallWidth}" stroke-linecap="round">${lines.join("")}</g>` +
    `<rect x="1" y="1" width="${width - 2}" height="${height - 2}" fill="none" stroke="${COLORS.wall}" stroke-width="${gridBorderWidth(cellSize)}" />` +
    solutionMarkup +
    markersMarkup +
    `</svg>`
  );
}

function buildPolarSVG(maze, canvasSize, showSolution) {
  const { grid, rings, start, end, solutionPath } = maze;
  const cx = canvasSize / 2;
  const cy = canvasSize / 2;
  const maxRadius = canvasSize / 2 - canvasSize * 0.04;
  const ringThickness = maxRadius / rings;
  const cellCenter = (cell) => polarCellCenter(grid, ringThickness, cx, cy, cell);

  const pt = (r, a) => `${cx + Math.cos(a) * r},${cy + Math.sin(a) * r}`;
  // SVG can't draw a full 360° circle as one arc (start/end points coincide).
  const arcOrCircle = (r, a0, a1) => {
    if (a1 - a0 >= Math.PI * 2 - 1e-6) {
      return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" />`;
    }
    const large = a1 - a0 > Math.PI ? 1 : 0;
    return `<path d="M ${pt(r, a0)} A ${r} ${r} 0 ${large} 1 ${pt(r, a1)}" fill="none" />`;
  };

  const wallWidth = polarWallWidth(canvasSize);
  const parts = [];

  for (const ring of grid) {
    const innerR = ring[0].ring * ringThickness;
    const outerR = innerR + ringThickness;
    for (const cell of ring) {
      const a0 = polarAngleOf(ring, cell.idx);
      const a1 = polarAngleOf(ring, cell.idx + 1);

      if (cell.ccw && !cell.links.has(cell.ccw)) {
        parts.push(
          `<line x1="${cx + Math.cos(a0) * innerR}" y1="${cy + Math.sin(a0) * innerR}" x2="${cx + Math.cos(a0) * outerR}" y2="${cy + Math.sin(a0) * outerR}" />`
        );
      }

      if (cell.outward.length > 0) {
        for (const child of cell.outward) {
          if (cell.links.has(child)) continue;
          const childRing = grid[child.ring];
          parts.push(arcOrCircle(outerR, polarAngleOf(childRing, child.idx), polarAngleOf(childRing, child.idx + 1)));
        }
      } else {
        parts.push(arcOrCircle(outerR, a0, a1));
      }
    }
  }

  let solutionMarkup = "";
  if (showSolution && solutionPath?.length) {
    const { width: strokeWidth, dash } = polarSolutionStyle(canvasSize);
    const points = solutionPath
      .map((cell) => {
        const p = cellCenter(cell);
        return `${p.x},${p.y}`;
      })
      .join(" ");
    solutionMarkup = `<polyline points="${points}" fill="none" stroke="${COLORS.thread}" stroke-width="${strokeWidth}" stroke-dasharray="${dash[0]},${dash[1]}" stroke-linecap="round" stroke-linejoin="round" />`;
  }

  const { radius: markerRadius, font: markerFont } = polarMarkerGeometry(ringThickness);
  const marker = (cell, color, label) => {
    const p = cellCenter(cell);
    return `<circle cx="${p.x}" cy="${p.y}" r="${markerRadius}" fill="${color}" /><text x="${p.x}" y="${p.y}" font-family="'JetBrains Mono', monospace" font-size="${markerFont}" font-weight="600" fill="${COLORS.canvasBg}" text-anchor="middle" dominant-baseline="central">${label}</text>`;
  };
  const markersMarkup = polarMarkers(start, end)
    .map(({ cell, color, label }) => marker(cell, color, label))
    .join("");

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${canvasSize}" height="${canvasSize}" viewBox="0 0 ${canvasSize} ${canvasSize}">` +
    `<rect x="0" y="0" width="${canvasSize}" height="${canvasSize}" fill="${COLORS.canvasBg}" />` +
    `<g stroke="${COLORS.wall}" stroke-width="${wallWidth}" stroke-linecap="round">${parts.join("")}</g>` +
    solutionMarkup +
    markersMarkup +
    `</svg>`
  );
}

// ---------------------------------------------------------------------------
// JSON serialize / deserialize
//
// Grid mazes are already plain data (nested arrays of booleans) so they
// round-trip trivially. Polar mazes store live object references (cw, ccw,
// inward, outward) and a Set of linked neighbors on each cell, neither of
// which JSON can represent directly — so cells are exported as flat
// {ring, idx, links:[[ring, idx], ...]} records and re-linked by rebuilding
// the deterministic polar skeleton (buildPolarGrid) on import, then
// reapplying the recorded links onto it.
// ---------------------------------------------------------------------------

function serializeMaze(maze) {
  const base = {
    version: 1,
    kind: maze.kind,
    seed: maze.seed,
    difficulty: maze.difficulty,
    shape: maze.shape,
    stats: maze.stats,
  };

  if (maze.kind === "polar") {
    return {
      ...base,
      rings: maze.rings,
      cells: maze.grid.flat().map((cell) => ({
        ring: cell.ring,
        idx: cell.idx,
        links: [...cell.links].map((n) => [n.ring, n.idx]),
      })),
      start: [maze.start.ring, maze.start.idx],
      end: [maze.end.ring, maze.end.idx],
      solutionPath: maze.solutionPath.map((c) => [c.ring, c.idx]),
    };
  }

  return {
    ...base,
    cols: maze.cols,
    rows: maze.rows,
    grid: maze.grid.map((row) => row.map((cell) => ({ N: cell.N, E: cell.E, S: cell.S, W: cell.W }))),
    start: maze.start,
    end: maze.end,
    solutionPath: maze.solutionPath,
  };
}

const VALID_DIFFICULTIES = new Set(Object.keys(DIFFICULTY_PRESETS));
const VALID_SHAPES = new Set(["square", "rect", "circular"]);
// Generous ceilings vs. the largest built-in preset (28x22 grid, 13 rings) —
// just enough to stop a malformed/hostile import from producing a cellSize
// that floors to 0px (a blank canvas) or hangs the tab building a huge grid.
const MAX_GRID_DIMENSION = 200;
const MAX_RINGS = 100;

function isFiniteInt(n) {
  return Number.isInteger(n);
}

// Every field pulled out of an imported file is untrusted: it can be
// hand-edited, from an older/newer export format, or just malformed JSON.
// This validates+reconstructs in one pass and throws a descriptive Error for
// any problem, which the caller (handleFileSelected) turns into the
// "Couldn't read that file" message — nothing here silently produces
// `undefined` cell references or NaN geometry downstream.
function deserializeMaze(data) {
  if (!data || typeof data !== "object") throw new Error("Not a maze file.");
  if (data.kind !== "grid" && data.kind !== "polar") throw new Error("Unrecognized maze kind.");

  if (data.shape !== undefined && !VALID_SHAPES.has(data.shape)) {
    throw new Error("Unrecognized shape.");
  }
  const shapeKind = data.shape === "circular" ? "polar" : "grid";
  if (data.shape !== undefined && shapeKind !== data.kind) {
    throw new Error("shape doesn't match kind.");
  }
  // Always end up with a shape that matches kind, even if the file omitted
  // it — keeps the Shape selector from ever showing something inconsistent
  // with the maze actually on screen.
  const shape = data.shape ?? (data.kind === "polar" ? "circular" : "rect");

  if (data.difficulty !== undefined && !VALID_DIFFICULTIES.has(data.difficulty)) {
    throw new Error("Unrecognized difficulty.");
  }
  const difficulty = data.difficulty;

  if (data.kind === "polar") {
    if (!isFiniteInt(data.rings) || data.rings < 1 || data.rings > MAX_RINGS) {
      throw new Error("Invalid ring count.");
    }
    if (!Array.isArray(data.cells) || !Array.isArray(data.start) || !Array.isArray(data.end) || !Array.isArray(data.solutionPath)) {
      throw new Error("Malformed polar maze data.");
    }

    const grid = buildPolarGrid(data.rings);
    const lookup = new Map();
    for (const ring of grid) for (const cell of ring) lookup.set(`${cell.ring}_${cell.idx}`, cell);

    const resolve = (pos) => {
      const cell = Array.isArray(pos) ? lookup.get(`${pos[0]}_${pos[1]}`) : undefined;
      if (!cell) throw new Error("Maze data references a cell outside its own grid.");
      return cell;
    };

    for (const c of data.cells) {
      const cell = resolve([c.ring, c.idx]);
      for (const link of c.links) cell.links.add(resolve(link));
    }

    const start = resolve(data.start);
    const end = resolve(data.end);
    const solutionPath = data.solutionPath.map(resolve);
    const uniqueSolution = verifyPolarSolution(start, end, solutionPath);

    return {
      kind: "polar",
      grid,
      rings: data.rings,
      start,
      end,
      solutionPath,
      seed: data.seed,
      difficulty,
      shape,
      stats: computePolarStats(grid, solutionPath, uniqueSolution),
    };
  }

  if (
    !isFiniteInt(data.cols) || data.cols < 1 || data.cols > MAX_GRID_DIMENSION ||
    !isFiniteInt(data.rows) || data.rows < 1 || data.rows > MAX_GRID_DIMENSION
  ) {
    throw new Error("Invalid grid dimensions.");
  }
  if (
    !Array.isArray(data.grid) ||
    data.grid.length !== data.rows ||
    data.grid.some((row) => !Array.isArray(row) || row.length !== data.cols)
  ) {
    throw new Error("Grid data doesn't match its declared dimensions.");
  }
  const inBounds = (pos) =>
    Array.isArray(pos) &&
    isFiniteInt(pos[0]) &&
    isFiniteInt(pos[1]) &&
    pos[0] >= 0 &&
    pos[0] < data.rows &&
    pos[1] >= 0 &&
    pos[1] < data.cols;
  if (!inBounds(data.start) || !inBounds(data.end)) throw new Error("Start/end out of bounds.");
  if (!Array.isArray(data.solutionPath) || !data.solutionPath.every(inBounds)) {
    throw new Error("Solution path out of bounds.");
  }

  const grid = data.grid.map((row) =>
    row.map((cell) => ({ N: !!cell.N, E: !!cell.E, S: !!cell.S, W: !!cell.W, visited: true }))
  );
  const uniqueSolution = verifyGridSolution(grid, data.cols, data.rows, data.start, data.end, data.solutionPath);

  return {
    kind: "grid",
    grid,
    cols: data.cols,
    rows: data.rows,
    start: data.start,
    end: data.end,
    solutionPath: data.solutionPath,
    seed: data.seed,
    difficulty,
    shape,
    stats: computeGridStats(grid, data.cols, data.rows, data.solutionPath, uniqueSolution),
  };
}

// ---------------------------------------------------------------------------
// File download helpers
// ---------------------------------------------------------------------------

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function filenameBase(maze) {
  const seedPart = String(maze.seed ?? "seed").replace(/[^a-zA-Z0-9_-]/g, "");
  return `maze_${maze.shape || maze.kind}_${maze.difficulty || "custom"}_${seedPart}`;
}

function getLayout(maze) {
  if (maze.kind === "polar") {
    return { kind: "polar", size: Math.floor(Math.min(MAX_CANVAS_WIDTH, MAX_CANVAS_HEIGHT)) };
  }
  return {
    kind: "grid",
    cellSize: Math.floor(Math.min(MAX_CANVAS_WIDTH / maze.cols, MAX_CANVAS_HEIGHT / maze.rows)),
  };
}

const MAX_CANVAS_WIDTH = 640;
const MAX_CANVAS_HEIGHT = 460;

export default function MazeGenerator() {
  const [difficulty, setDifficulty] = useState("medium");
  const [shape, setShape] = useState("rect");
  const [showSolution, setShowSolution] = useState(false);
  const [seedText, setSeedText] = useState(() => generateRandomSeedString());
  const [seed, setSeed] = useState(seedText);
  const [importedMaze, setImportedMaze] = useState(null);
  const [importError, setImportError] = useState(null);
  const [tickerOverflowing, setTickerOverflowing] = useState(false);
  const canvasRef = useRef(null);
  const fileInputRef = useRef(null);
  const tickerContainerRef = useRef(null);
  const tickerMeasureRef = useRef(null);

  // Pure function of (difficulty, shape, seed) — same seed always reproduces
  // the same maze. `importedMaze`, when present, takes over the display
  // without needing to touch this.
  const generatedMaze = useMemo(() => {
    const rng = mulberry32(hashSeed(seed));
    const preset = DIFFICULTY_PRESETS[difficulty];
    const result =
      shape === "circular"
        ? generatePolarMaze(preset.circular, preset.loopRate, rng)
        : generateMaze(preset[shape][0], preset[shape][1], preset.loopRate, rng);
    return { ...result, seed, difficulty, shape };
  }, [difficulty, shape, seed]);

  const maze = importedMaze ?? generatedMaze;

  useEffect(() => {
    if (!canvasRef.current) return;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");
    const layout = getLayout(maze);
    if (layout.kind === "polar") {
      canvas.width = layout.size;
      canvas.height = layout.size;
      drawPolarMaze(ctx, maze, layout.size, showSolution);
    } else {
      canvas.width = maze.cols * layout.cellSize;
      canvas.height = maze.rows * layout.cellSize;
      drawMaze(ctx, maze, layout.cellSize, showSolution);
    }
  }, [maze, showSolution]);

  const handleDifficultyChange = (key) => {
    setDifficulty(key);
    setImportedMaze(null);
  };

  const handleShapeChange = (key) => {
    setShape(key);
    setImportedMaze(null);
  };

  const handleNewMaze = () => {
    const s = generateRandomSeedString();
    setSeedText(s);
    setSeed(s);
    setImportedMaze(null);
  };

  const handleLoadSeed = () => {
    if (!seedText.trim()) return;
    setSeed(seedText.trim());
    setImportedMaze(null);
  };

  const handleSavePNG = () => {
    if (!canvasRef.current) return;
    canvasRef.current.toBlob((blob) => {
      if (blob) downloadBlob(blob, `${filenameBase(maze)}.png`);
    }, "image/png");
  };

  const handleSaveSVG = () => {
    const layout = getLayout(maze);
    const svgMarkup =
      layout.kind === "polar"
        ? buildPolarSVG(maze, layout.size, showSolution)
        : buildGridSVG(maze, layout.cellSize, showSolution);
    downloadBlob(new Blob([svgMarkup], { type: "image/svg+xml" }), `${filenameBase(maze)}.svg`);
  };

  const handleExportJSON = () => {
    const data = serializeMaze(maze);
    downloadBlob(new Blob([JSON.stringify(data)], { type: "application/json" }), `${filenameBase(maze)}.json`);
  };

  const handleImportClick = () => fileInputRef.current?.click();

  const handleFileSelected = (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;

    const reader = new FileReader();
    reader.onload = () => {
      try {
        // deserializeMaze fully validates data (kind, shape/kind consistency,
        // difficulty, dimensions, and every cell/start/end/solution-path
        // reference) and throws for anything malformed, so nothing bad can
        // reach setState below — restored.shape/difficulty are guaranteed
        // either a known-valid value or undefined.
        const data = JSON.parse(reader.result);
        const restored = deserializeMaze(data);
        setImportedMaze(restored);
        if (restored.seed !== undefined) setSeedText(String(restored.seed));
        if (restored.difficulty !== undefined) setDifficulty(restored.difficulty);
        setShape(restored.shape);
        setImportError(null);
      } catch {
        setImportError("Couldn't read that file — make sure it's a maze exported from this app.");
      }
    };
    reader.readAsText(file);
  };

  const segButton = (active) => ({
    padding: "6px 14px",
    fontSize: 13,
    fontFamily: '"JetBrains Mono", monospace',
    borderRadius: 6,
    border: `1px solid ${active ? COLORS.start : COLORS.border}`,
    background: active ? "rgba(242, 184, 75, 0.15)" : "transparent",
    color: active ? COLORS.start : COLORS.text,
    cursor: "pointer",
  });

  const seedInputStyle = {
    flex: 1,
    minWidth: 0,
    padding: "6px 8px",
    fontSize: 13,
    fontFamily: '"JetBrains Mono", monospace',
    borderRadius: 6,
    border: `1px solid ${COLORS.border}`,
    background: "transparent",
    color: COLORS.text,
  };

  const statsLine = [
    `seed ${maze.seed}`,
    maze.kind === "polar" ? `rings ${maze.rings}` : `grid ${maze.cols}×${maze.rows}`,
    `cells ${maze.stats.cells}`,
    `solution ${maze.stats.solutionLength} steps`,
    `dead ends ${maze.stats.deadEnds}`,
    `loops ${maze.stats.loopsAdded}`,
    `routes ${maze.stats.uniqueSolution ? "unique" : "multiple"}`,
  ].join("   •   ");

  // Only scroll when the text actually doesn't fit — a hidden measurement
  // copy (same font, out of layout flow) gives the line's natural width,
  // compared against the panel's available width. Re-checked whenever the
  // text changes (new maze/import) and whenever the panel itself resizes
  // (e.g. the layout re-wrapping at a narrow viewport).
  useEffect(() => {
    const container = tickerContainerRef.current;
    const measure = tickerMeasureRef.current;
    if (!container || !measure) return;

    const check = () => setTickerOverflowing(measure.scrollWidth > container.clientWidth);
    check();

    const observer = new ResizeObserver(check);
    observer.observe(container);
    return () => observer.disconnect();
  }, [statsLine]);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 12,
        padding: 20,
        fontFamily: '"Space Grotesk", system-ui, sans-serif',
        color: COLORS.text,
      }}
    >
      <div style={{ display: "flex", alignItems: "flex-start", gap: 20, flexWrap: "wrap" }}>
      <div
        style={{
          background: COLORS.panelBg,
          border: `3px solid ${COLORS.border}`,
          borderRadius: 10,
          padding: 18,
          width: 220,
          flexShrink: 0,
        }}
      >
        <div style={{ fontSize: 12, color: COLORS.textMuted, marginBottom: 6 }}>Difficulty</div>
        <div style={{ display: "flex", gap: 6, marginBottom: 16, flexWrap: "wrap" }}>
          {Object.entries(DIFFICULTY_PRESETS).map(([key, preset]) => (
            <button
              key={key}
              style={segButton(difficulty === key)}
              aria-pressed={difficulty === key}
              onClick={() => handleDifficultyChange(key)}
            >
              {preset.label}
            </button>
          ))}
        </div>

        <div style={{ fontSize: 12, color: COLORS.textMuted, marginBottom: 6 }}>Shape</div>
        <div style={{ display: "flex", gap: 6, marginBottom: 16, flexWrap: "wrap" }}>
          <button
            style={segButton(shape === "square")}
            aria-pressed={shape === "square"}
            onClick={() => handleShapeChange("square")}
          >
            Square
          </button>
          <button
            style={segButton(shape === "rect")}
            aria-pressed={shape === "rect"}
            onClick={() => handleShapeChange("rect")}
          >
            Rectangle
          </button>
          <button
            style={segButton(shape === "circular")}
            aria-pressed={shape === "circular"}
            onClick={() => handleShapeChange("circular")}
          >
            Circular
          </button>
        </div>

        <div style={{ fontSize: 12, color: COLORS.textMuted, marginBottom: 6 }}>Seed</div>
        <div style={{ display: "flex", gap: 6, marginBottom: 16 }}>
          <input
            style={seedInputStyle}
            value={seedText}
            onChange={(e) => setSeedText(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleLoadSeed()}
            aria-label="Maze seed"
            placeholder="seed"
          />
          <button style={segButton(false)} onClick={handleLoadSeed} title="Regenerate with this seed">
            Load
          </button>
        </div>

        <button
          style={{ ...segButton(false), width: "100%", marginBottom: 8, padding: "8px 14px" }}
          onClick={handleNewMaze}
        >
          New maze
        </button>
        <button
          style={{ ...segButton(showSolution), width: "100%", marginBottom: 16, padding: "8px 14px" }}
          aria-pressed={showSolution}
          onClick={() => setShowSolution((v) => !v)}
        >
          {showSolution ? "Hide solution" : "Show solution"}
        </button>

        <div style={{ fontSize: 12, color: COLORS.textMuted, marginBottom: 6 }}>Save image</div>
        <div style={{ display: "flex", gap: 6, marginBottom: 16 }}>
          <button style={{ ...segButton(false), flex: 1 }} onClick={handleSavePNG}>
            PNG
          </button>
          <button style={{ ...segButton(false), flex: 1 }} onClick={handleSaveSVG}>
            SVG
          </button>
        </div>

        <div style={{ fontSize: 12, color: COLORS.textMuted, marginBottom: 6 }}>Maze data</div>
        <div style={{ display: "flex", gap: 6, marginBottom: importError ? 8 : 0 }}>
          <button style={{ ...segButton(false), flex: 1 }} onClick={handleExportJSON}>
            Export
          </button>
          <button style={{ ...segButton(false), flex: 1 }} onClick={handleImportClick}>
            Import
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".json,application/json"
            style={{ display: "none" }}
            onChange={handleFileSelected}
          />
        </div>
        {importError && (
          <div role="alert" style={{ fontSize: 12, color: COLORS.end, marginBottom: 4 }}>
            {importError}
          </div>
        )}
      </div>

      <div
        style={{
          background: COLORS.panelBg,
          border: `1px solid ${COLORS.border}`,
          borderRadius: 10,
          padding: 16,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <canvas
          ref={canvasRef}
          role="img"
          aria-label={`Generated maze, ${
            maze.kind === "polar" ? `${maze.rings} rings` : `${maze.cols} by ${maze.rows} cells`
          }${showSolution ? ", solution path shown" : ""}`}
          style={{ display: "block", borderRadius: 4 }}
        />
      </div>
      </div>

      <div
        ref={tickerContainerRef}
        style={{
          position: "relative",
          overflow: "hidden",
          background: COLORS.panelBg,
          border: `1px solid ${COLORS.border}`,
          borderRadius: 10,
          padding: "8px 0",
        }}
      >
        {/* Invisible, out-of-flow copy used only to measure the line's
            natural width — same font as the visible line(s) below so the
            measurement is accurate. */}
        <span
          ref={tickerMeasureRef}
          style={{
            position: "absolute",
            visibility: "hidden",
            whiteSpace: "nowrap",
            fontFamily: '"JetBrains Mono", monospace',
            fontSize: 12,
          }}
        >
          {statsLine}
        </span>

        {tickerOverflowing ? (
          <>
            {/* Static, unanimated copy for screen readers/reduced-motion
                users — the visible track below is duplicated content for
                the scroll loop, so it's hidden from the accessibility tree. */}
            <span
              style={{
                position: "absolute",
                width: 1,
                height: 1,
                margin: -1,
                padding: 0,
                overflow: "hidden",
                clip: "rect(0, 0, 0, 0)",
                whiteSpace: "nowrap",
              }}
            >
              {statsLine}
            </span>
            <div
              aria-hidden="true"
              className="maze-stats-ticker-track"
              style={{
                display: "flex",
                width: "max-content",
                whiteSpace: "nowrap",
                fontFamily: '"JetBrains Mono", monospace',
                fontSize: 12,
                color: COLORS.textMuted,
                animation: "maze-stats-ticker 24s linear infinite",
              }}
            >
              <span style={{ paddingRight: 48 }}>{statsLine}</span>
              <span style={{ paddingRight: 48 }}>{statsLine}</span>
            </div>
          </>
        ) : (
          // Fits without scrolling: a single centered, static, fully
          // accessible line — no animation, no duplicated content.
          <div
            style={{
              whiteSpace: "nowrap",
              textAlign: "center",
              fontFamily: '"JetBrains Mono", monospace',
              fontSize: 12,
              color: COLORS.textMuted,
            }}
          >
            {statsLine}
          </div>
        )}
      </div>
    </div>
  );
}
# MazeGenerator

A procedural maze generator and solver that runs entirely in your browser — free, no accounts, no ads, and fully playable offline once the page has loaded.

## Features

- **Guaranteed-solvable mazes.** Every maze is generated as a spanning tree over a grid (a randomized recursive backtracker), so there's always exactly one path between any two cells before any extra complexity is added — no dead-end generation bugs, no unreachable areas.
- **Three shapes.** Rectangle, Square, and Circular ("Theta") mazes — circular mazes are built on a polar grid (rings × angular sectors) with their own carving/rendering logic, not a stretched rectangle.
- **Three difficulty presets.** Easy, Medium, and Hard scale both the grid size and the "loop rate" — Medium and Hard remove a handful of extra walls to add genuine false branches, without ever breaking solvability.
- **Seeded, reproducible mazes.** Every maze is generated from a seed string — type your own memorable seed or generate a random one, and the same seed + difficulty + shape always reproduces the identical maze.
- **Solve it by hand.** Trace your own path directly on the maze with mouse or touch (Draw/Erase modes, Clear line), or reveal the actual solution path with one click.
- **Export & import.** Save a maze as a PNG or SVG image, or export/import the full maze data as JSON — imported files are fully validated so a malformed or hand-edited file fails with a clear error instead of crashing the app.
- **No backend, no tracking.** Everything — generation, rendering, solving, export — runs client-side. Nothing is uploaded anywhere.

## Stack

- **Vite + React 19**
- Maze generation, rendering, and export all live in `src/App.jsx` — a randomized recursive backtracker for grid mazes, a parallel polar-grid version for circular mazes, and canvas + SVG renderers that share the same path-drawing logic so exports match what's on screen exactly.

## Run

```bash
npm install
npm run dev      # http://localhost:5173
```

```bash
npm run build    # production build -> dist/
npm run preview  # serve the build
```

## Project structure

```
src/
  App.jsx       maze generation (grid + polar), canvas rendering, solving UI, PNG/SVG/JSON export+import
  index.css     base theme (light/dark aware) and layout
  main.jsx      React entry point
public/
  favicon.svg
```

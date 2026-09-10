# Subprojects

## Atom Memory

[Atom Memory](https://github.com/tako0614/atom-memory) is an independently versioned TypeScript library based on `atom_memory_final_v1.zip`. This repository pins its source as a Git submodule at `subprojects/atom-memory`.

- Documentation: https://atom-memory.takos.jp
- npm: https://www.npmjs.com/package/atom-memory
- Install: `npm install atom-memory`

Initialize the source checkout with:

```sh
git submodule update --init subprojects/atom-memory
```

Run the library's own checks inside that directory with `npm ci && npm run check`. Changes to the library, its package release, and its documentation belong to the independent repository. Sakana builds the pinned source during root `npm ci` and uses its public entry points from `src/conversation/memory.js`. The host owns Discord ingestion, access policies, and the shared agent runtime. See [the integration architecture](../docs/agent-architecture.md).

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

Run checks inside that directory with `npm ci && npm run check`. Changes to the library, its package release, and its documentation belong to the independent repository. The Sakana runtime does not automatically install or invoke the library by initializing this submodule.

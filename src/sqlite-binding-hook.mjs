// Redirect the bare `better-sqlite3` ESM import to the copy installed in
// 9router-api's own node_modules.
//
// Why: 9router-api consumes the 9router codebase as a library via tsconfig
// path aliases (`@/*` -> ../9router/src/*), so 9router's source files resolve
// `better-sqlite3` from 9router/node_modules at runtime. That copy is
// better-sqlite3 12.11.1, which ships no prebuilt binary for Node 26
// (ABI 147), so its native binding fails to load ("Could not locate the
// bindings file"). Pinning 13.0.3 in this project (a version with Node 26
// prebuilds) and redirecting resolution here restores the preferred driver
// without modifying the read-only 9router repo.
import { registerHooks } from 'node:module';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);

let betterSqlite3Url = null;
try {
  betterSqlite3Url = pathToFileURL(require.resolve('better-sqlite3')).href;
} catch {
  // better-sqlite3 not installed in this project — leave resolution untouched
  // so 9router falls back to node:sqlite / sql.js as usual.
}

// Guard for Node < 22.15 (module.registerHooks landed in 22.15.0): on older
// runtimes skip hook registration entirely and leave resolution untouched so
// 9router falls back to node:sqlite / sql.js as usual.
if (betterSqlite3Url && typeof registerHooks === 'function') {
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === 'better-sqlite3') {
        return { url: betterSqlite3Url, shortCircuit: true };
      }
      return nextResolve(specifier, context);
    },
  });
}

// Side-effect module: imported from server.ts (and bundled into dist) purely
// to register the resolve hook before any dynamic import of the DB adapters.
export default null;
// Test-only module hook: resolves `@earendil-works/*` packages from the locally installed Pi release,
// so tests run without installing Pi packages into this repository or globally.
// Usage: node --import ./pi-theme-minimalism/test-resolve-pi.mjs --test pi-theme-minimalism/*.test.mjs
// Override the install location with PI_INSTALL_DIR=/path/to/releases/<version>.
import { existsSync, readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

function piInstallDir() {
  if (process.env.PI_INSTALL_DIR) return process.env.PI_INSTALL_DIR;
  const installRoot = join(homedir(), '.pi/agent/install');
  const versionFile = join(installRoot, 'current-version');
  if (!existsSync(versionFile)) {
    throw new Error(`Pi install not found: ${versionFile} is missing; set PI_INSTALL_DIR to a Pi release directory`);
  }
  return join(installRoot, 'releases', readFileSync(versionFile, 'utf8').trim());
}

const installDir = piInstallDir();
if (!existsSync(join(installDir, 'node_modules/@earendil-works'))) {
  throw new Error(`Pi packages not found in ${installDir}/node_modules; set PI_INSTALL_DIR to a Pi release directory`);
}
// Resolve as if imported from a module in the release root, so its node_modules is used.
const parentURL = pathToFileURL(join(installDir, 'test-resolve-pi.mjs')).href;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('@earendil-works/')) return nextResolve(specifier, { ...context, parentURL });
    return nextResolve(specifier, context);
  },
});

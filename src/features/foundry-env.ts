/**
 * Foundry environment helpers.
 *
 * The VS Code extension host does NOT inherit the user's interactive shell PATH
 * when the app is launched from the Dock / Finder (macOS) or a desktop launcher
 * (Linux). Foundry installs its tools to `~/.foundry/bin` (anvil, forge, cast),
 * which is added to PATH by the shell rc files — invisible to a GUI-launched
 * process. Any time we spawn a Foundry tool we must augment PATH ourselves, or
 * the spawn fails with ENOENT and the feature silently appears "broken".
 */

import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

/**
 * Returns a child-process env identical to the current one but with the common
 * Foundry / cargo / Homebrew bin directories prepended to PATH (only the ones
 * that actually exist on disk).
 */
export function getAugmentedEnv(): NodeJS.ProcessEnv {
  const home = os.homedir();
  const extraPaths = [
    path.join(home, '.foundry', 'bin'),
    path.join(home, '.cargo', 'bin'),
    '/usr/local/bin',
    '/opt/homebrew/bin',
  ].filter((p) => fs.existsSync(p));

  return {
    ...process.env,
    PATH: [...extraPaths, process.env.PATH || ''].join(path.delimiter),
  };
}

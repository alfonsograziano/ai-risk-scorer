// Cloud sign-in steps that run before the action can leave a credentials file
// in the workspace: google-github-actions/auth writes gha-creds-*.json there.
// The reviewer reads inside the workspace, so the file is moved out first and
// the variables that point at it are updated. The agent still signs in with
// it; it just cannot open it as a file to review.
import { copyFile, rm } from 'node:fs/promises';
import { existsSync, realpathSync } from 'node:fs';
import { basename, isAbsolute, join, relative } from 'node:path';

/** Variables that name a Google credentials file. google-github-actions/auth sets all three to the same path. */
export const CREDENTIAL_FILE_VARIABLES = ['GOOGLE_APPLICATION_CREDENTIALS', 'GOOGLE_GHA_CREDS_PATH', 'CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE'] as const;

function inside(dir: string, file: string): boolean {
  const rel = relative(realpathSync(dir), realpathSync(file));
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

/**
 * Moves every credentials file named in env that lies inside `workspace` to
 * `safeDir`, and points the variables at the new path. Returns the files moved,
 * as paths relative to the workspace.
 */
export async function moveCredentialFilesOut(workspace: string, safeDir: string, env: Record<string, string | undefined>): Promise<string[]> {
  // Resolve every variable first: once a file is moved, the other variables naming it point at nothing.
  const named = new Map<string, string>();
  for (const name of CREDENTIAL_FILE_VARIABLES) {
    const file = env[name];
    if (file && existsSync(file)) named.set(name, realpathSync(file));
  }
  const moved = new Map<string, string>();
  for (const real of new Set(named.values())) {
    if (!inside(workspace, real)) continue;
    const target = join(safeDir, `nhr-${basename(real)}`);
    await copyFile(real, target);
    await rm(real);
    moved.set(real, target);
  }
  for (const [name, real] of named) {
    const target = moved.get(real);
    if (target) env[name] = target;
  }
  return [...moved.keys()].map((f) => relative(realpathSync(workspace), f));
}

/**
 * The `preinstall` of @oar-sh/oar. Nothing of OAR loads before the `try`:
 * a module of this package that cannot load (a broken file, a missing one)
 * must not fail the install on any platform. Only a copy of an old
 * database that failed (RescueCopyError) exits 1, so npm stops the update
 * and puts the old package, data and all, back in place; anything else is
 * one line and exit 0, as this script only ever copies. See
 * package-data-rescue.mjs.
 */
import { fileURLToPath } from 'node:url';

try {
  const { rescuePackageData } = await import('./package-data-rescue.mjs');
  rescuePackageData({ packageRoot: fileURLToPath(new URL('../..', import.meta.url)) });
} catch (error) {
  if (error?.rescueCopyFailed === true) {
    console.error(`[oar] ${error.message}`);
    process.exitCode = 1;
  } else {
    console.error(`[oar] Did not copy the data of the version being replaced: ${error?.message || error}`);
  }
}

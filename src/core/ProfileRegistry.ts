/**
 * ProfileRegistry — compatibility face of core/BranchRegistry.
 *
 * Profiles now live in BRANCHES (one Chromium user-data root each; see
 * core/BranchRegistry). Every former caller keeps this name and its methods
 * (list / get / create / rename / remove / ensure / dirOf / recordOpenError);
 * `dirOf` now returns the profile's BRANCH ROOT (the --user-data-dir) and
 * `profilePathOf` the profile's own folder inside it.
 *
 * `new ProfileRegistry(profilesDir)` keeps working (tests): new branches then
 * go to `<profilesDir>/branches` unless a base is given.
 */
import path from 'path';
import { BranchRegistry, type BranchRegistryOptions } from './BranchRegistry';

export {
  DEFAULT_PROFILE_ID, ProfileRegistryError, normalizeProfileName, newProfileId,
  profileDirFor, legacyProfileDir, type ProfileEntry, type RegistryErrorCode, type BranchRecord,
} from './BranchRegistry';

/** Former per-profile meta file (still read when adopting legacy profiles). */
export const META_FILE = '.plyr-profile.json';

export class ProfileRegistry extends BranchRegistry {
  constructor(profilesDir: string, opts: Partial<Omit<BranchRegistryOptions, 'profilesDir'>> = {}) {
    super({
      profilesDir,
      baseDir: opts.baseDir || (() => path.join(profilesDir, 'branches')),
      reconcileBase: opts.reconcileBase,
      log: opts.log,
    });
  }
}

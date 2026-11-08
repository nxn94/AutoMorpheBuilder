'use strict';

/**
 * APKEditor argument list for merging a split package (XAPK/APKM/APKS)
 * into a single APK.
 *
 * Pure function with no I/O, so the flag set is testable without a JVM
 * or a bundle on disk. `download-supported-apk.js`'s
 * `mergeSplitPackageWithApkeditor` spawns `java` with exactly this argv.
 *
 * The merge deliberately does NOT pass `-clean-meta`. That flag deletes
 * the bundle's whole `META-INF` directory before the APK is re-emitted,
 * and the patcher needs it: a patch may read the original APK's
 * metadata. Two patches in `hxreborn/morphe-patches` do, and both fail
 * on a stripped merge:
 *
 *   - `aliexpress/.../SigningDataPatch` reads `META-INF/*.RSA` and
 *     aborts with "Expected one AliExpress signing certificate entry"
 *     when the glob matches nothing. Nine patches depend on it.
 *   - `iiec/.../BypassSignatureCheckPatch` renames `META-INF` and
 *     aborts with "META-INF not found in the input APK".
 *
 * Keeping the directory ships nothing stale. morphe-desktop signs the
 * patched APK, and its signer replaces the v1 signature files, so the
 * output carries only its own `META-INF/<alias>.{SF,RSA}` either way —
 * verified on com.alibaba.aliexpresshd 8.180.1 (see the PR that added
 * this module for the before/after entry listings).
 *
 * @param {string} jar    Path to APKEditor.jar.
 * @param {string} input  Path to the split package.
 * @param {string} output Path for the merged APK.
 * @returns {string[]} argv for `java`, excluding the executable itself.
 */
function apkeditorMergeArgs(jar, input, output) {
  return ['-jar', jar, 'm', '-i', input, '-o', output];
}

module.exports = {
  apkeditorMergeArgs,
};

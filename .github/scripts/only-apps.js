'use strict';

/**
 * ONLY_APPS: a comma- or space-separated list of app names or package ids.
 * When set, only those apps are built, even if their release is current.
 */

function parseOnlyApps(value) {
  return String(value || '').split(/[\s,]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
}

/** Pure. null when nothing is selected. */
function selectApps(matrix, value) {
  const wanted = new Set(parseOnlyApps(value));
  if (!wanted.size) return null;
  const keys = (e) => [String(e.name).toLowerCase(), String(e.appId).toLowerCase()];
  const picked = matrix.filter((e) => keys(e).some((k) => wanted.has(k)));
  const known = new Set(picked.flatMap(keys));
  return {
    matrix: picked,
    skipList: matrix.filter((e) => !picked.includes(e)).map((e) => e.appId),
    unknown: [...wanted].filter((w) => !known.has(w)),
  };
}

module.exports = { parseOnlyApps, selectApps };

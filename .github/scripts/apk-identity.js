'use strict';

function parseIdentity(badging) {
  const packageLine = badging.split('\n').find((line) => line.startsWith('package:')) || '';
  return {
    packageName: packageLine.match(/\bname='([^']+)'/)?.[1] || '',
    version: packageLine.match(/\bversionName='([^']+)'/)?.[1] || '',
  };
}

function assertIdentity(identity, packageName, version) {
  if (!identity.packageName || !identity.version) throw new Error('APK package/version metadata is unreadable');
  if (identity.packageName !== packageName) throw new Error(`Wrong APK package: ${identity.packageName}; expected ${packageName}`);
  if (identity.version !== version) throw new Error(`Wrong APK version: ${identity.version}; expected ${version}`);
  return identity;
}

function inspectIdentity(file, packageName, version, execImpl = require('node:child_process').execFileSync) {
  let badging = '';
  for (const tool of ['aapt', 'aapt2']) {
    try {
      badging = execImpl(tool, ['dump', 'badging', file], { encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] });
      if (parseIdentity(badging).packageName) break;
    } catch { /* Try the other installed badging tool. */ }
  }
  return assertIdentity(parseIdentity(badging), packageName, version);
}

module.exports = { parseIdentity, assertIdentity, inspectIdentity };

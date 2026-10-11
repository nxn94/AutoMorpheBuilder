'use strict';

function verifyArchiveDigest(bytes, expected) {
  if (!expected) return;
  if (!/^[a-f0-9]{64}$/.test(expected)) throw new Error('Invalid pinned browser SHA-256');
  const actual = require('node:crypto').createHash('sha256').update(bytes).digest('hex');
  if (actual !== expected) throw new Error(`Browser archive SHA-256 mismatch: expected ${expected}, got ${actual}`);
}

module.exports = { verifyArchiveDigest };

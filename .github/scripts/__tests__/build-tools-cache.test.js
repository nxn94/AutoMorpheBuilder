'use strict';

const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

const { jobs } = yaml.load(fs.readFileSync(path.resolve(__dirname, '../../workflows/morphe-build.yml'), 'utf8'));

const installs = (job) => jobs[job].steps
  .map((step, index) => ({ step, index }))
  .filter(({ step }) => step.run === 'bash .github/scripts/pipeline/install_aapt.sh');
const cacheStep = (job) => jobs[job].steps
  .map((step, index) => ({ step, index }))
  .find(({ step }) => /^actions\/cache(\/restore)?@/.test(step.uses || '')
    && step.with?.path?.endsWith('/build-tools'));

test.each(['check-versions', 'build'])('%s restores build-tools before installing aapt', (job) => {
  const [install] = installs(job);
  const cache = cacheStep(job);
  expect(install).toBeDefined();
  expect(cache).toBeDefined();
  expect(cache.index).toBeLessThan(install.index);
  // install-aapt.js looks for build-tools under ANDROID_HOME, so the cached path must match.
  expect(cache.step.with.path).toBe(`${install.step.env.ANDROID_HOME}/build-tools`);
  // A version bump in install-aapt.js must miss the old entry.
  expect(cache.step.with.key).toContain("hashFiles('.github/scripts/install-aapt.js', 'checksums/tools.sha256')");
  expect(cache.step.if).toBe(install.step.if);
});

test('every job uses the same cache key', () => {
  const keys = ['check-versions', 'build'].map((job) => cacheStep(job).step.with.key);
  expect(new Set(keys).size).toBe(1);
});

test('only check-versions saves the cache; the build legs only restore it', () => {
  expect(cacheStep('check-versions').step.uses).toMatch(/^actions\/cache@/);
  expect(cacheStep('build').step.uses).toMatch(/^actions\/cache\/restore@/);
});

test('the signing job installs build-tools fresh and restores no cache', () => {
  // Build legs run third-party patch code and can write caches; create-release holds the keystore.
  expect(installs('create-release')).toHaveLength(1);
  expect(jobs['create-release'].steps.some((s) => /^actions\/cache/.test(s.uses || ''))).toBe(false);
});

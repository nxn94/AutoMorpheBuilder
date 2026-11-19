'use strict';

const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

const { jobs } = yaml.load(fs.readFileSync(path.resolve(__dirname, '../../workflows/morphe-build.yml'), 'utf8'));

const indexOf = (job, pred) => jobs[job].steps.findIndex(pred);
const isInstall = (step) => step.run === 'bash .github/scripts/pipeline/install_aapt.sh';
const isToolsArtifact = (step) => step.with?.name === 'android-build-tools';

test('no job restores build-tools from a cross-run cache', () => {
  // Build legs run third-party patch code and can write caches.
  for (const job of Object.keys(jobs)) {
    const cached = (jobs[job].steps || []).filter((s) => /^actions\/cache/.test(s.uses || '')
      && /android-sdk|build-tools/.test(String(s.with?.path)));
    expect(cached).toEqual([]);
  }
});

test('check-versions installs fresh, then packs and uploads build-tools with a digest output', () => {
  const steps = jobs['check-versions'].steps;
  const install = indexOf('check-versions', isInstall);
  const pack = indexOf('check-versions', (s) => s.id === 'share-build-tools');
  const upload = indexOf('check-versions', (s) => /^actions\/upload-artifact@/.test(s.uses || '') && isToolsArtifact(s));
  expect(install).toBeGreaterThanOrEqual(0);
  expect(install).toBeLessThan(pack);
  expect(pack).toBeLessThan(upload);
  expect(steps[pack].run).toContain('-C /tmp/android-sdk -cf "$RUNNER_TEMP/android-build-tools.tar" build-tools');
  expect(steps[pack].run).toContain('sha256=');
  expect(steps[upload].with.path).toBe('${{ runner.temp }}/android-build-tools.tar');
  expect(steps[pack].if).toBe(steps[install].if);
  expect(steps[upload].if).toBe(steps[install].if);
  expect(jobs['check-versions'].outputs['build-tools-sha256']).toBe('${{ steps.share-build-tools.outputs.sha256 }}');
});

test('build legs extract the artifact only when it matches the digest, before installing aapt', () => {
  const steps = jobs.build.steps;
  const download = indexOf('build', (s) => /^actions\/download-artifact@/.test(s.uses || '') && isToolsArtifact(s));
  const unpack = indexOf('build', (s) => s.env?.EXPECTED_SHA256 !== undefined);
  const install = indexOf('build', isInstall);
  expect(download).toBeGreaterThanOrEqual(0);
  expect(download).toBeLessThan(unpack);
  expect(unpack).toBeLessThan(install);
  expect(steps[download].with.path).toBe('${{ runner.temp }}/android-build-tools');
  expect(steps[download]['continue-on-error']).toBe(true);
  expect(steps[unpack].env.EXPECTED_SHA256).toBe('${{ needs.check-versions.outputs.build-tools-sha256 }}');
  const run = steps[unpack].run;
  // The digest check must gate the only extraction.
  expect(run.match(/tar /g)).toHaveLength(1);
  expect(run.indexOf('sha256sum -c')).toBeLessThan(run.indexOf('tar '));
  // install-aapt.js looks for build-tools under ANDROID_HOME.
  expect(run).toContain('tar -C /tmp/android-sdk -xf');
  expect(steps[install].env.ANDROID_HOME).toBe('/tmp/android-sdk');
});

test('the signing job installs build-tools fresh and takes neither cache nor artifact', () => {
  expect(jobs['create-release'].steps.filter(isInstall)).toHaveLength(1);
  expect(jobs['create-release'].steps.some((s) => /^actions\/cache/.test(s.uses || '') || isToolsArtifact(s))).toBe(false);
});

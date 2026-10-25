'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const yaml = require('js-yaml');
const root = path.resolve(__dirname, '../../..');

test('both downloader jobs install the pinned optional goopdl provider', () => {
  const workflow = yaml.load(fs.readFileSync(path.join(root, '.github/workflows/morphe-build.yml'), 'utf8'));
  for (const job of ['check-versions', 'build']) {
    expect(workflow.jobs[job].steps.some(step => step.run === 'bash .github/scripts/pipeline/install_goopdl.sh')).toBe(true);
  }
});

test('optional installation failure leaves the original providers usable', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'goopdl-install-'));
  try {
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'python3'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    const tools = path.join(dir, 'tools');
    fs.mkdirSync(path.join(tools, 'goopdl'), { recursive: true });
    fs.writeFileSync(path.join(tools, 'apkeep'), 'existing provider');
    const result = spawnSync('bash', [path.join(root, '.github/scripts/pipeline/install_goopdl.sh')], {
      encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, TOOLS_DIR: tools },
    });
    expect(result.status).toBe(0);
    expect(result.stderr).toContain('existing APK sources remain available');
    expect(fs.existsSync(path.join(tools, 'goopdl'))).toBe(false);
    expect(fs.readFileSync(path.join(tools, 'apkeep'), 'utf8')).toBe('existing provider');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('pre-download accepts a local goopdl artifact without caching an expiring Play URL', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'goopdl-pipeline-'));
  try {
    const bin = path.join(dir, 'bin'); const tools = path.join(dir, 'tools'); const results = path.join(dir, 'results');
    fs.mkdirSync(bin); fs.mkdirSync(tools);
    fs.writeFileSync(path.join(tools, 'supported-versions.json'), JSON.stringify({ 'com.test': ['1.2'] }));
    const config = path.join(dir, 'config.json');
    fs.writeFileSync(config, JSON.stringify({ auto_update_urls: true, patch_repos: { 'com.test': {} } }));
    fs.writeFileSync(path.join(bin, 'node'), `#!/usr/bin/env bash\nset -eu\nif [[ "$1" == *unified-downloader.js ]]; then\n mkdir -p "$4"\n printf fixture > "$4/test.apkm"\n printf '{"success":true,"source":"goopdl","file":"%s/test.apkm"}\\n' "$4"\nelif [[ "$1" == *update-download-urls.js ]]; then\n exit 99\nelse\n exec "${process.execPath}" "$@"\nfi\n`, { mode: 0o755 });
    const result = spawnSync('bash', [path.join(root, '.github/scripts/pipeline/pre_download_apks.sh')], {
      encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CONFIG_FILE: config, TOOLS_DIR: tools, RESULTS_DIR: results },
    });
    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain('unified-downloader failed');
    expect(fs.existsSync(path.join(results, 'com.test.failed'))).toBe(false);
    expect(fs.existsSync(path.join(results, 'com.test.txt'))).toBe(false);
    expect(fs.existsSync(path.join(tools, 'apks/com.test/test.apkm'))).toBe(true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

#!/usr/bin/env node
// Cut a release: bump the version, commit, tag. Pushing the tag runs .github/workflows/release.yml.
//   npm run release -- cli patch     fshare-cli 0.2.0 -> 0.2.1, tag cli-v0.2.1
//   npm run release -- app minor     app 1.0.0 -> 1.1.0 (versionCode 10100), tag app-v1.1.0
// Versions are semver. The APK's versionCode is derived: major*10000 + minor*100 + patch, so it
// always increases with the version (Android refuses to install a lower one over a higher one).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

export function bump(version, part) {
  const [major, minor, patch] = version.split('.').map(Number);
  if (part === 'major') return `${major + 1}.0.0`;
  if (part === 'minor') return `${major}.${minor + 1}.0`;
  if (part === 'patch') return `${major}.${minor}.${patch + 1}`;
  if (/^\d+\.\d+\.\d+$/.test(part)) return part;
  throw new Error(`expected patch, minor, major or x.y.z, got "${part}"`);
}

export function versionCode(version) {
  const [major, minor, patch] = version.split('.').map(Number);
  if (minor > 99 || patch > 99) throw new Error('minor and patch must stay below 100');
  return major * 10000 + minor * 100 + patch;
}

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const writeJson = (f, v) => fs.writeFileSync(f, JSON.stringify(v, null, 2) + '\n');

function main() {
  const [what, part = 'patch'] = process.argv.slice(2);
  if (!['cli', 'app'].includes(what)) {
    console.log('usage: npm run release -- <cli|app> [patch|minor|major|x.y.z]');
    process.exit(1);
  }
  if (git('status', '--porcelain')) throw new Error('commit or stash your changes first');
  if (git('rev-parse', '--abbrev-ref', 'HEAD') !== 'main') throw new Error('release from main');

  let next, files;
  if (what === 'cli') {
    const pkg = readJson('cli/package.json');
    next = bump(pkg.version, part);
    pkg.version = next;
    writeJson('cli/package.json', pkg);
    const lock = readJson('cli/package-lock.json');
    lock.version = next;
    lock.packages[''].version = next;
    writeJson('cli/package-lock.json', lock);
    files = ['cli/package.json', 'cli/package-lock.json'];
  } else {
    const app = readJson('mobile/app.json');
    next = bump(app.expo.version, part);
    app.expo.version = next;
    app.expo.android.versionCode = versionCode(next);
    app.expo.ios.buildNumber = String(versionCode(next));
    writeJson('mobile/app.json', app);
    files = ['mobile/app.json'];
  }
  const tag = `${what}-v${next}`;
  git('add', ...files);
  git('commit', '-m', `release: ${what} v${next}`);
  git('tag', '-a', tag, '-m', `${what} v${next}`);
  console.log(`Tagged ${tag}. Push it to publish:\n  git push origin main ${tag}`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();

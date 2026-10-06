#!/usr/bin/env node
// Releases, in two steps (main is protected, so version bumps go through a PR like everything else):
//
//   1. npm run release -- <cli|app> <patch|minor|major|x.y.z>
//      bumps the version on a release/<what>-v<x.y.z> branch and opens a PR. CI checks it.
//   2. after merging: npm run release:publish -- <cli|app>   (on an up-to-date main)
//      cli: pushes tag cli-v<x.y.z>; CI tests it and makes the GitHub release (install.sh installs from GitHub).
//      app: builds the APK on this Mac, pushes tag app-v<x.y.z>, and makes the GitHub release with the APK.
//
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

const run = (cmd, ...args) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['inherit', 'pipe', 'inherit'] }).trim();
const live = (cmd, ...args) => execFileSync(cmd, args, { stdio: 'inherit' });
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const writeJson = (f, v) => fs.writeFileSync(f, JSON.stringify(v, null, 2) + '\n');
const current = (what) => (what === 'cli' ? readJson('cli/package.json').version : readJson('mobile/app.json').expo.version);

function onCleanMain() {
  if (run('git', 'status', '--porcelain')) throw new Error('commit or stash your changes first');
  if (run('git', 'rev-parse', '--abbrev-ref', 'HEAD') !== 'main') throw new Error('switch to main first');
  live('git', 'pull', '--ff-only');
}

function prepare(what, part) {
  onCleanMain();
  const next = bump(current(what), part);
  const branch = `release/${what}-v${next}`;
  live('git', 'switch', '-c', branch);
  if (what === 'cli') {
    const pkg = readJson('cli/package.json');
    pkg.version = next;
    writeJson('cli/package.json', pkg);
    const lock = readJson('cli/package-lock.json');
    lock.version = next;
    lock.packages[''].version = next;
    writeJson('cli/package-lock.json', lock);
  } else {
    const app = readJson('mobile/app.json');
    app.expo.version = next;
    app.expo.android.versionCode = versionCode(next);
    app.expo.ios.buildNumber = String(versionCode(next));
    writeJson('mobile/app.json', app);
    const pkg = readJson('mobile/package.json');
    pkg.version = next;
    writeJson('mobile/package.json', pkg);
    const lock = readJson('mobile/package-lock.json');
    lock.version = next;
    lock.packages[''].version = next;
    writeJson('mobile/package-lock.json', lock);
  }
  live('npx', 'prettier', '--write', '--log-level=warn', what === 'cli' ? 'cli/package*.json' : 'mobile/{app,package,package-lock}.json');
  live('git', 'commit', '-am', `release: ${what} v${next}`);
  live('git', 'push', '-u', 'origin', branch);
  live(
    'gh',
    'pr',
    'create',
    '--title',
    `Release ${what} v${next}`,
    '--body',
    `Bumps ${what} to v${next}. After merging: \`npm run release:publish -- ${what}\``,
  );
}

function publish(what) {
  onCleanMain();
  const version = current(what);
  const tag = `${what}-v${version}`;
  if (run('git', 'tag', '--list', tag)) throw new Error(`${tag} already exists; bump the version first`);
  if (what === 'app') live('bash', 'scripts/build-apk.sh'); // before tagging, so a failed build leaves nothing behind
  live('git', 'tag', '-a', tag, '-m', `${what} v${version}`);
  live('git', 'push', 'origin', tag);
  if (what === 'app') {
    // uploaded as fshare.apk, so releases/latest/download/fshare.apk (the README's link) is always the newest
    fs.copyFileSync(`dist/fshare-${version}.apk`, 'dist/fshare.apk');
    live('gh', 'release', 'create', tag, 'dist/fshare.apk', '--title', `fshare ${version}`, '--generate-notes', '--latest');
  } else {
    console.log(`Pushed ${tag}: CI tests it and creates the GitHub release.`);
  }
}

function main() {
  const [step, what, part = 'patch'] = process.argv.slice(2);
  if (!['prepare', 'publish'].includes(step) || !['cli', 'app'].includes(what)) {
    console.log('usage: npm run release -- <cli|app> [patch|minor|major|x.y.z]\n       npm run release:publish -- <cli|app>');
    process.exit(1);
  }
  if (step === 'prepare') prepare(what, part);
  else publish(what);
}

if (import.meta.url === `file://${process.argv[1]}`) main();

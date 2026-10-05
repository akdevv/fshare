import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bump, versionCode } from './release.mjs';

test('semver bumps', () => {
  assert.equal(bump('0.2.0', 'patch'), '0.2.1');
  assert.equal(bump('0.2.9', 'minor'), '0.3.0');
  assert.equal(bump('1.4.2', 'major'), '2.0.0');
  assert.equal(bump('1.4.2', '3.0.0'), '3.0.0');
  assert.throws(() => bump('1.0.0', 'huge'));
});

test('APK versionCode always grows with the version', () => {
  assert.equal(versionCode('1.0.0'), 10000);
  assert.equal(versionCode('1.2.3'), 10203);
  assert.ok(versionCode('1.10.0') > versionCode('1.9.99'));
  assert.ok(versionCode('2.0.0') > versionCode('1.99.99'));
  assert.throws(() => versionCode('1.100.0'));
});

#!/usr/bin/env node
// Asks App Store Connect whether a store lane can submit a version right now.
// Run as a script by the Mac App Store lane (mas-publish.yml, mas-catchup.yml;
// docs/mas-release.md) and imported by the iOS lane (prepare_ios_release.mjs;
// docs/ios-release.md), which takes the same decision for the IOS platform.
//
// App Store Connect keeps one version per platform in flight. While the
// previous version waits for or sits in review (or is pending release), a new
// version cannot be created and fastlane deliver dies on "You cannot create a
// new version of the App in the current state" (2026-10-09, 2026-10-27). The
// lanes ask here first and defer instead of failing; their scheduled runs ask
// again every two hours and submit the latest release once Apple is done.
//
// Environment: ASC_API_KEY_ID, ASC_API_ISSUER_ID, ASC_API_KEY_P8 (base64 .p8)
// Arguments:   --bundle-id <identifier> --version <x.y.z> [--platform MAC_OS]
// Outputs (GITHUB_OUTPUT when set, always printed):
//   decision=publish|blocked|done   reason=<one line>
//   min_build=<CFBundleVersion above every build already uploaded for the version, or empty>
import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ascClientFromEnv } from '../../scripts/asc-api.mjs';

// deliver takes these over (spaceship get_edit_app_store_version) and renames
// them to the new version string before it uploads and submits.
export const EDITABLE_STATES = new Set([
  'PREPARE_FOR_SUBMISSION', 'DEVELOPER_REJECTED', 'REJECTED', 'METADATA_REJECTED', 'INVALID_BINARY',
]);

// In flight with Apple: no new version may be created, and cancelling a
// review from CI would only send the app to the back of the queue. Wait.
// (WAITING_FOR_REVIEW is in deliver's editable set, but renaming a waiting
// version to the next number is refused, so it is treated as blocking here.)
export const BLOCKING_STATES = new Set([
  'READY_FOR_REVIEW', 'WAITING_FOR_REVIEW', 'WAITING_FOR_EXPORT_COMPLIANCE', 'IN_REVIEW',
  'PENDING_APPLE_RELEASE', 'PENDING_DEVELOPER_RELEASE', 'PROCESSING_FOR_DISTRIBUTION',
  'PROCESSING_FOR_APP_STORE', 'ACCEPTED', 'PREORDER_READY_FOR_SALE',
]);

// versions: [{ versionString, state }] for one platform. Every other state
// (READY_FOR_DISTRIBUTION, REPLACED_WITH_NEW_VERSION, REMOVED_FROM_SALE, …)
// is history and never stops a new version. platformLabel only words the reason.
export function decideStorePublish(versions, version, platformLabel = 'macOS') {
  const same = versions.find((item) => item.versionString === version);
  if (same && !EDITABLE_STATES.has(same.state)) {
    return { decision: 'done', reason: `${version} is already on App Store Connect (${same.state})` };
  }
  const blocking = versions.filter((item) => item.versionString !== version && BLOCKING_STATES.has(item.state));
  if (blocking.length) {
    const held = blocking.map((item) => `${item.versionString} is ${item.state}`).join(', ');
    return { decision: 'blocked', reason: `${held}; App Store Connect allows one ${platformLabel} version in flight` };
  }
  if (same) return { decision: 'publish', reason: `${version} is ${same.state}; deliver re-submits it` };
  return { decision: 'publish', reason: `no ${platformLabel} version is in flight; deliver creates ${version}` };
}

// CFBundleVersion strings of the builds already uploaded for the version →
// the next number above all of them, or null when none exists.
export function nextBuildNumber(buildNumbers) {
  const numbers = buildNumbers.map(Number).filter((value) => Number.isInteger(value) && value >= 0);
  return numbers.length ? Math.max(...numbers) + 1 : null;
}

// The app record and its versions of one platform (MAC_OS, IOS), newest
// first: [{ versionString, state, created }]. Throws on API errors.
export async function fetchStoreVersions(request, bundleId, platform) {
  const apps = (await request('GET', `/v1/apps?filter[bundleId]=${encodeURIComponent(bundleId)}&limit=5`)).data;
  const app = apps.find((item) => item.attributes.bundleId === bundleId);
  if (!app) throw new Error(`no app with bundle id ${bundleId}`);
  const versions = (await request('GET', `/v1/apps/${app.id}/appStoreVersions?filter[platform]=${platform}`
    + '&fields[appStoreVersions]=versionString,appVersionState,createdDate&limit=200')).data
    .map((item) => ({
      versionString: item.attributes.versionString,
      state: item.attributes.appVersionState,
      created: item.attributes.createdDate,
    }))
    .sort((a, b) => String(b.created).localeCompare(String(a.created)));
  return { app, versions };
}

export function printStoreVersions(platform, bundleId, versions, max = 8) {
  console.log(`${platform} versions of ${bundleId} on App Store Connect (newest first):`);
  for (const item of versions.slice(0, max)) console.log(`  ${item.versionString.padEnd(10)} ${item.state.padEnd(28)} ${item.created ?? ''}`);
  if (versions.length > max) console.log(`  … ${versions.length - max} older`);
}

export function storeVersionsTable(versions, max = 8) {
  const rows = versions.slice(0, max).map((item) => `| ${item.versionString} | ${item.state} | ${item.created ?? ''} |`).join('\n');
  return `| Version | State | Created |\n| --- | --- | --- |\n${rows}\n`;
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index].startsWith('--')) args[argv[index].slice(2)] = argv[index + 1];
  }
  return args;
}

function fail(message) {
  console.error(`asc_mas_state: ${message}`);
  process.exit(1);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const bundleId = args['bundle-id'];
  const version = args.version;
  const platform = args.platform || 'MAC_OS';
  if (!bundleId) fail('missing --bundle-id');
  if (!/^\d+\.\d+\.\d+$/.test(version || '')) fail(`invalid --version '${version}' (expected x.y.z)`);

  let request;
  try { request = ascClientFromEnv(); } catch (error) { fail(error.message); }

  let app;
  let versions;
  let builds;
  try {
    ({ app, versions } = await fetchStoreVersions(request, bundleId, platform));
    builds = (await request('GET', `/v1/builds?filter[app]=${app.id}&filter[preReleaseVersion.platform]=${platform}`
      + `&filter[preReleaseVersion.version]=${encodeURIComponent(version)}&fields[builds]=version,processingState,uploadedDate&limit=200`)).data
      .map((item) => item.attributes.version);
  } catch (error) {
    fail(error.message);
  }

  const label = platform === 'IOS' ? 'iOS' : 'macOS';
  const result = decideStorePublish(versions, version, label);
  const minBuild = nextBuildNumber(builds);

  printStoreVersions(platform, bundleId, versions);
  console.log(`builds already uploaded for ${version}: ${builds.length ? builds.join(', ') : 'none'}`);
  console.log(`decision=${result.decision}`);
  console.log(`reason=${result.reason}`);
  console.log(`min_build=${minBuild ?? ''}`);

  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `decision=${result.decision}\nreason=${result.reason}\nmin_build=${minBuild ?? ''}\n`);
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY,
      `### ${label === 'iOS' ? 'App Store' : 'Mac App Store'} ${version}: ${result.decision}\n\n${result.reason}.\n\n${storeVersionsTable(versions)}\n`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}

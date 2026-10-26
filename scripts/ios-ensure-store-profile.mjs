#!/usr/bin/env node
// Fetch or create the manually managed iOS App Store provisioning profile
// through the App Store Connect API (ios-release.yml). Xcode-managed
// profiles ("iOS Team Store Provisioning Profile: …") are refused by the
// manual signing that `tauri ios build --ci` configures, so the release lane
// owns a profile of its own, keyed by name, and recreates it when the
// signing certificate changes or the profile stops being ACTIVE.
//
// Environment: ASC_API_KEY_ID, ASC_API_ISSUER_ID, ASC_API_KEY_P8 (base64 .p8)
// Arguments:   --bundle-id <identifier> --certificate-sha1 <hex>
//              --name <profile name> --out <path.mobileprovision>
import { writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { ascClientFromEnv } from './asc-api.mjs';

const args = Object.fromEntries(process.argv.slice(2).map((value, index, list) =>
  value.startsWith('--') ? [value.slice(2), list[index + 1]] : null).filter(Boolean));
const required = ['bundle-id', 'certificate-sha1', 'name', 'out'];
for (const key of required) if (!args[key]) fail(`missing --${key}`);
for (const key of ['ASC_API_KEY_ID', 'ASC_API_ISSUER_ID', 'ASC_API_KEY_P8']) if (!process.env[key]) fail(`missing ${key}`);

function fail(message) {
  console.error(`ios-ensure-store-profile: ${message}`);
  process.exit(1);
}

const request = ascClientFromEnv();
async function api(method, path, body) {
  try {
    return await request(method, path, body);
  } catch (error) {
    fail(error.message);
  }
}

const bundleIdentifier = args['bundle-id'];
const bundles = (await api('GET', `/v1/bundleIds?filter[identifier]=${encodeURIComponent(bundleIdentifier)}&limit=50`)).data
  .filter((item) => item.attributes.identifier === bundleIdentifier);
const bundle = bundles.find((item) => ['IOS', 'UNIVERSAL'].includes(item.attributes.platform)) ?? bundles[0];
if (!bundle) fail(`bundle identifier ${bundleIdentifier} is not registered`);
console.log(`bundle id ${bundle.id} (${bundle.attributes.platform}) "${bundle.attributes.name}"`);

const wantedSha1 = args['certificate-sha1'].replace(/:/g, '').toUpperCase();
const certificates = (await api('GET', '/v1/certificates?filter[certificateType]=DISTRIBUTION&limit=200')).data;
const certificate = certificates.find((item) =>
  createHash('sha1').update(Buffer.from(item.attributes.certificateContent, 'base64')).digest('hex').toUpperCase() === wantedSha1);
if (!certificate) fail(`no Apple Distribution certificate with SHA-1 ${wantedSha1} (team has ${certificates.length})`);
console.log(`certificate ${certificate.id} "${certificate.attributes.displayName}" expires ${certificate.attributes.expirationDate}`);

const name = args.name;
const existing = (await api('GET', `/v1/profiles?filter[profileType]=IOS_APP_STORE&filter[name]=${encodeURIComponent(name)}&include=certificates&limit=20`));
let profile = existing.data.find((item) => item.attributes.name === name) ?? null;
if (profile) {
  const certificateIds = (profile.relationships?.certificates?.data ?? []).map((item) => item.id);
  const usable = profile.attributes.profileState === 'ACTIVE' && certificateIds.includes(certificate.id);
  if (usable) {
    console.log(`reusing profile ${profile.id} (${profile.attributes.profileState}, expires ${profile.attributes.expirationDate})`);
  } else {
    console.log(`profile ${profile.id} is ${profile.attributes.profileState} with certificates [${certificateIds.join(', ')}]; recreating`);
    await api('DELETE', `/v1/profiles/${profile.id}`);
    profile = null;
  }
}
if (!profile) {
  profile = (await api('POST', '/v1/profiles', {
    data: {
      type: 'profiles',
      attributes: { name, profileType: 'IOS_APP_STORE' },
      relationships: {
        bundleId: { data: { type: 'bundleIds', id: bundle.id } },
        certificates: { data: [{ type: 'certificates', id: certificate.id }] },
      },
    },
  })).data;
  console.log(`created profile ${profile.id} "${profile.attributes.name}" expires ${profile.attributes.expirationDate}`);
}
if (!profile.attributes.profileContent) profile = (await api('GET', `/v1/profiles/${profile.id}`)).data;
writeFileSync(args.out, Buffer.from(profile.attributes.profileContent, 'base64'));
console.log(`wrote ${args.out} (uuid ${profile.attributes.uuid}, ${profile.attributes.profileState})`);

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
import { createHash, createSign } from 'node:crypto';

const args = Object.fromEntries(process.argv.slice(2).map((value, index, list) =>
  value.startsWith('--') ? [value.slice(2), list[index + 1]] : null).filter(Boolean));
const required = ['bundle-id', 'certificate-sha1', 'name', 'out'];
for (const key of required) if (!args[key]) fail(`missing --${key}`);
for (const key of ['ASC_API_KEY_ID', 'ASC_API_ISSUER_ID', 'ASC_API_KEY_P8']) if (!process.env[key]) fail(`missing ${key}`);

function fail(message) {
  console.error(`ios-ensure-store-profile: ${message}`);
  process.exit(1);
}

const b64url = (buffer) => Buffer.from(buffer).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const now = Math.floor(Date.now() / 1000);
const header = b64url(JSON.stringify({ alg: 'ES256', kid: process.env.ASC_API_KEY_ID, typ: 'JWT' }));
const payload = b64url(JSON.stringify({ iss: process.env.ASC_API_ISSUER_ID, iat: now, exp: now + 900, aud: 'appstoreconnect-v1' }));
const signer = createSign('SHA256');
signer.update(`${header}.${payload}`);
const key = Buffer.from(process.env.ASC_API_KEY_P8, 'base64').toString('utf8');
const token = `${header}.${payload}.${b64url(signer.sign({ key, dsaEncoding: 'ieee-p1363' }))}`;

async function api(method, path, body) {
  const response = await fetch(`https://api.appstoreconnect.apple.com${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (response.status === 204) return null;
  const text = await response.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 300) }; }
  if (!response.ok) {
    const detail = JSON.stringify(json.errors ?? json).slice(0, 700);
    fail(`${method} ${path} -> HTTP ${response.status}: ${detail}`);
  }
  return json;
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

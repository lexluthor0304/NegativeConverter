// The RAW decoder's licence notices must be complete (#264's native decoder,
// reviewed in #229).
//
// LibRaw (CDDL-1.0), musl's math functions and, on macOS, the LLVM OpenMP
// runtime are compiled into every macOS and Linux desktop binary:
// build_libraw.rs is not a cargo feature, so the App Store build has them too,
// whatever the runtime gate says, and every app runs LibRaw as libraw-wasm.
// Their licences ask for the holders' notices in what recipients get (the BSD
// and NCSA terms, Sun's "provided that this notice is preserved", MIT's "above
// copyright notice", Apache-2.0 §4).
// negative2positive/public/licenses/raw-decoder-notices.txt carries them; this
// checks that
//
// - every copyright and SPDX line in the header comments of the vendored
//   sources (src-tauri/vendor/libraw, libomp, portable-math), and every
//   permission notice there, is in it: musl's COPYRIGHT leaves the notices of
//   its math files (Arm's MIT, Sun's) to those files, and several LibRaw
//   decoders name holders its COPYRIGHT does not;
// - the vendored licence files are reproduced in full.
//
//   node scripts/check-third-party-notices.mjs
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const vendorDir = join(repoRoot, 'src-tauri', 'vendor');
// Where the site and the app serve it, relative to their root.
const NOTICES_PATH = 'licenses/raw-decoder-notices.txt';
const noticesFile = join(repoRoot, 'negative2positive', 'public', NOTICES_PATH);

const SOURCE_DIRS = ['libraw', 'libomp', 'portable-math'];
const SOURCE_EXTENSIONS = new Set(['.c', '.cc', '.cpp', '.cxx', '.h', '.hh', '.hpp']);
// Reproduced in full, not only quoted.
const LICENCE_FILES = ['libraw/COPYRIGHT', 'libraw/LICENSE.CDDL', 'portable-math/musl/COPYRIGHT', 'libomp/macos/LICENSE.TXT'];

const collapse = text => text.replace(/\s+/g, ' ').trim();

/**
 * The comments at the top of a C/C++ source, up to its first line of code,
 * one array of lines per comment. Blank and preprocessor lines in between are
 * skipped (one of LibRaw's X3F files opens with `#ifdef USE_X3FTOOLS`).
 */
function headerComments(source) {
  const comments = [];
  let block = null;
  for (const raw of source.split(/\r?\n/)) {
    const line = raw.trim();
    if (block) {
      block.push(line);
      if (line.includes('*/')) block = null;
      continue;
    }
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('//')) { comments.push([line]); continue; }
    if (!line.startsWith('/*')) break;
    comments.push([line]);
    if (!line.slice(2).includes('*/')) block = comments.at(-1);
  }
  return comments;
}

const commentText = line => collapse(line.replace(/^(?:\/\*+|\/\/+|\*+(?!\/))/, '').replace(/\*+\/$/, ''));
const isNoticeLine = line => /SPDX-License-Identifier:/.test(line)
  || (/\bcopyright\b/i.test(line) && /\b(?:19|20)\d\d\b/.test(line));
// The grants of the permissive licences in these trees: Sun's "Permission to
// use ... provided that this notice is preserved", MIT's, and the BSD terms
// that ask for the notice in binary distributions.
const GRANT = /Permission to use|Permission is hereby granted|Redistribution and use in source and binary forms/i;

/**
 * What a source's header asks recipients to get: its copyright lines (a
 * "copyright" with a year) and SPDX tags, and every permission notice in full,
 * from its first copyright line to the end of its comment.
 */
function headerNotices(source) {
  const notices = [];
  for (const comment of headerComments(source)) {
    const lines = comment.map(commentText);
    notices.push(...lines.filter(isNoticeLine));
    if (!GRANT.test(lines.join(' '))) continue;
    const first = lines.findIndex(isNoticeLine);
    notices.push(collapse(lines.slice(Math.max(first, 0)).join(' ')));
  }
  return notices;
}

function sourceFiles(dir, out = []) {
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sourceFiles(path, out);
    else if (SOURCE_EXTENSIONS.has(extname(name).toLowerCase())) out.push(path);
  }
  return out;
}

/** Every distinct notice of the vendored sources, with the files that carry it. */
function vendoredNotices(root = vendorDir) {
  const notices = new Map();
  for (const file of SOURCE_DIRS.flatMap(dir => sourceFiles(join(root, dir)))) {
    for (const notice of headerNotices(readFileSync(file, 'utf8'))) {
      notices.set(notice, [...(notices.get(notice) || []), relative(root, file)]);
    }
  }
  return [...notices].map(([notice, files]) => ({ notice, files }));
}

function vendoredLicences(root = vendorDir) {
  return LICENCE_FILES.map(file => ({ file, text: readFileSync(join(root, file), 'utf8') }));
}

/** What `notices` lacks: header notices, and licence files it does not reproduce in full. */
function missingFromNotices(notices, required, licences) {
  const text = collapse(notices);
  const quote = notice => JSON.stringify(notice.length > 100 ? notice.slice(0, 97) + '...' : notice);
  return [
    ...required.filter(({ notice }) => !text.includes(notice))
      .map(({ notice, files }) => `${quote(notice)} (${files.slice(0, 3).join(', ')}${files.length > 3 ? ', …' : ''})`),
    ...licences.filter(licence => !text.includes(collapse(licence.text))).map(({ file }) => `${file} in full`),
  ];
}

const problems = [];
const notices = readFileSync(noticesFile, 'utf8');
const required = vendoredNotices();
const licences = vendoredLicences();

// The header reader has to find what is there: Arm's and Sun's notices in the
// musl files, LibRaw's holders and the BSD terms of its DCB and X3F code, and
// libomp's SPDX tag.
assert.deepEqual(headerNotices('#ifdef X\n\n/* A\n * Copyright (c) 2001, A.\n */\n// SPDX-License-Identifier: MIT\nint a; /* Copyright 2002 B */\n'),
  ['Copyright (c) 2001, A.', 'SPDX-License-Identifier: MIT']);
assert.deepEqual(headerNotices('/* x.c */\n/*\n * ====\n * Copyright (C) 1993 by S.\n *\n * Permission to use is granted,\n * provided that this notice is preserved.\n * ====\n */\n/* f(x) */\nint f;\n'),
  ['Copyright (C) 1993 by S.', 'Copyright (C) 1993 by S. Permission to use is granted, provided that this notice is preserved. ====']);
for (const pattern of [/Arm Limited/, /Sun Microsystems.*Permission to use/, /LibRaw LLC/, /Karlsson.*Redistribution and use/, /Gozdz.*Redistribution and use/, /Apache-2\.0 WITH LLVM-exception/]) {
  assert.ok(required.some(({ notice }) => pattern.test(notice)), `no notice matching ${pattern} found in src-tauri/vendor`);
}

for (const item of missingFromNotices(notices, required, licences)) problems.push(`${NOTICES_PATH} lacks ${item}`);

if (problems.length) {
  console.error('FAIL third-party notices:\n  ' + problems.join('\n  '));
  process.exit(1);
}

// It can fail: without the Arm paragraphs of the musl files or the notice of
// cos.c (R2-045), or with a licence file cut short.
const withoutArm = notices.replace(/^.*Arm Limited\.\n.*SPDX-License-Identifier: MIT\n/gm, '');
assert.ok(withoutArm !== notices, 'mutation found no Arm paragraph to delete');
assert.ok(missingFromNotices(withoutArm, required, licences).some(item => item.includes('Arm Limited')),
  'deleting the Arm paragraphs went unnoticed');
const withoutCos = notices.replace(/^cos\.c \(origin[^]*?(?=^__cos\.c)/m, '');
assert.ok(withoutCos !== notices, 'mutation found no cos.c paragraph to delete');
assert.ok(missingFromNotices(withoutCos, required, licences).some(item => item.includes('SunPro') && item.includes('cos.c')),
  'deleting the notice of cos.c went unnoticed');
const cddl = licences.find(({ file }) => file === 'libraw/LICENSE.CDDL').text;
const lastCddlSentence = cddl.split('\n').filter(line => /[a-z]/i.test(line)).pop();
assert.ok(missingFromNotices(notices.replace(lastCddlSentence, ''), required, licences).includes('libraw/LICENSE.CDDL in full'),
  'a truncated CDDL text went unnoticed');

console.log(`ok: ${NOTICES_PATH} carries the ${required.length} header notices of ${SOURCE_DIRS.length} vendored trees and ${licences.length} licence files in full`);

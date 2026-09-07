import { readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
export const site = 'https://negative-converter.tokugai.com';
export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'negative2positive');
export function searchFiles() {
  return [...readdirSync(root).filter(name=>name.endsWith('.html')), ...['zh','ja'].flatMap(lang=>readdirSync(resolve(root,lang)).filter(name=>name.endsWith('.html')).map(name=>`${lang}/${name}`))];
}
export const canonicalPath = file => '/' + (file==='index.html'?'':file.replace(/\/index\.html$/,'/'));

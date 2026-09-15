import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const bytes = readFileSync(new URL('../../public/models/efficientvit-b1-ade20k.onnx', import.meta.url));
assert.equal(createHash('sha256').update(bytes).digest('hex'), '904544216395cf81b583771c9ca107994b388dc379fc3beabeaf57cd1e76d3f9');
assert.match(readFileSync(new URL('../../public/models/EfficientViT-LICENSE.txt', import.meta.url), 'utf8'), /Apache License/);
assert.ok(bytes.includes(Buffer.from('image')) && bytes.includes(Buffer.from('logits')));
console.log('semantic model hash, licence and named contract passed');

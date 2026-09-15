# MI-GAN Places2 Pipeline v2

MI-GAN 公式 README が案内する著者配布 ONNX Pipeline を同梱。

- Project: https://github.com/Picsart-AI-Research/MI-GAN
- Source: https://huggingface.co/andraniksargsyan/migan/resolve/1538c135034b8cfe7a8472f34d09c8a5a45b17a7/migan_pipeline_v2.onnx
- Revision: `1538c135034b8cfe7a8472f34d09c8a5a45b17a7`
- SHA-256: `6f1f3530a1a2324b19752018ce756088b07973cda8d7d890034ace5c8a48c40b`
- License: MIT, `MI-GAN-LICENSE.txt` を参照。

モデルファイルは変更せず配置。入力は `image` / `mask` (uint8 NCHW)、
出力は `result` (uint8 NCHW)。マスクは 255 = 保持、0 = 修復。
更新時はアダプタの契約テスト、モデル SHA-256、実推論 smoke を同時に更新する。

# EfficientViT B1 ADE20K

- Project: https://github.com/mit-han-lab/efficientvit
- Code revision: `1b80bf5880775fd000bd9e6807433b54aedb8b1f`
- Weight source: https://huggingface.co/han-cai/efficientvit-seg/resolve/cf3ccaf9cbaf670a2cb283612773546824ca0aa1/efficientvit_seg_b1_ade20k.pt
- Licence: Apache-2.0, `EfficientViT-LICENSE.txt`.
- ONNX SHA-256: `904544216395cf81b583771c9ca107994b388dc379fc3beabeaf57cd1e76d3f9`
- Input: `image`, float32 NCHW `[1,3,512,512]`, RGB ImageNet mean/std.
- Output: `logits`, float32 `[1,150,64,64]`, zero-based ADE20K classes.
- Export: opset 17, eval mode, unmodified B1 network and strict pretrained state dict.
  The export environment omits the unrelated `from .sam import *` re-export
  in efficientvit/models/efficientvit/__init__.py, so it does not need Segment
  Anything. B1 model computation is unchanged.
- Reproduce with scripts/export-semantic-model.py, PyTorch 2.14.0 / ONNX 1.22.0.

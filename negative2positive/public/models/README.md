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

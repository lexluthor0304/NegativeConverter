# Export-only Python environment; see public/models/README.md for pinned source.
import sys
import argparse
p = argparse.ArgumentParser()
p.add_argument('--source', required=True)
p.add_argument('--checkpoint', required=True)
p.add_argument('--output', required=True)
args = p.parse_args()
sys.path.insert(0, args.source)
import torch
from efficientvit.seg_model_zoo import create_seg_model
model = create_seg_model(name='b1', dataset='ade20k', pretrained=False)
checkpoint=torch.load(args.checkpoint,map_location='cpu',weights_only=True)
model.load_state_dict(checkpoint.get('state_dict',checkpoint))
model.eval()
image=torch.zeros(1,3,512,512)
with torch.no_grad():
 print('contract',model(image).shape,flush=True)
 torch.onnx.export(model,image,args.output,input_names=['image'],output_names=['logits'],opset_version=17,dynamo=False)
print('exported',flush=True)

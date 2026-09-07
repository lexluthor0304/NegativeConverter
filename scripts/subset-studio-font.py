# Optional maintainer tool: pip install fonttools[woff]==4.60.1
from fontTools import subset
from fontTools.ttLib import TTFont
from pathlib import Path
root = Path(__file__).resolve().parents[1] / 'negative2positive/public/fonts/fusion-pixel'
font = TTFont(root / 'fusion-pixel-12px-proportional-zh_hans.otf.woff2')
options = subset.Options()
options.flavor = 'woff2'
subsetter = subset.Subsetter(options=options)
subsetter.populate(unicodes=list(range(0x20,0x250))+list(range(0x2000,0x2070))+list(range(0x2190,0x2200))+[0x2212])
subsetter.subset(font)
for record in font['name'].names:
    if record.nameID in (1,4,6,16):
        record.string = ('NCStudioLatin' if record.nameID == 6 else 'NC Studio Latin').encode(record.getEncoding())
font.save(root / 'nc-studio-latin.woff2')
print((root / 'nc-studio-latin.woff2').stat().st_size)

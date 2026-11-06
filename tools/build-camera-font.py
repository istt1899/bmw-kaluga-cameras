"""Bake the open Inter font into a small Cyrillic/Latin alpha atlas; host only.
Usage: python tools/build-camera-font.py /path/to/InterVariable.ttf
The font source is https://github.com/rsms/inter (SIL OFL 1.1).
"""
import base64, json, pathlib, sys, zlib
from PIL import Image, ImageDraw, ImageFont
root = pathlib.Path(__file__).resolve().parent.parent
chars = ''.join(chr(i) for i in range(32, 127)) + ''.join(chr(i) for i in range(1040, 1104)) + 'Ёё•°—'
sizes = []
for size in (18, 24, 32):
    font = ImageFont.truetype(sys.argv[1], size)
    try:
        font.set_variation_by_axes([600 if a['name'] == b'Weight' else a['default'] for a in font.get_variation_axes()])
    except (AttributeError, OSError):
        pass
    atlas = Image.new('L', (512, 1024)); draw = ImageDraw.Draw(atlas)
    glyphs = {}; x = y = row = 0
    for char in chars:
        left, top, right, bottom = font.getbbox(char, anchor='ls')
        w, h = right-left, bottom-top
        if x+w+2 > atlas.width:
            x = 0; y += row+2; row = 0
        draw.text((x-left, y-top), char, font=font, fill=255, anchor='ls')
        glyphs[str(ord(char))] = [x,y,w,h,left,top,round(font.getlength(char),3)]
        x += w+2; row = max(row,h)
    atlas = atlas.crop((0,0,512,y+row+1))
    sizes.append({'size':size,'ascent':font.getmetrics()[0], 'atlasW':atlas.width,'atlasH':atlas.height,'glyphs':glyphs,
                  'alpha':base64.b64encode(zlib.compress(atlas.tobytes(),9)).decode('ascii')})
doc = {'copyright':'Copyright 2016 The Inter Project Authors; SIL OFL 1.1', 'source':'https://github.com/rsms/inter','sizes':sizes}
target=root/'native/marku-kaluga-cameras/files/camera-font.json'
target.write_text(json.dumps(doc,separators=(',',':'))+'\n',encoding='utf-8')
print('Baked Cyrillic alert atlas:',target.name)

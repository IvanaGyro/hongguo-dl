# SPDX-License-Identifier: GPL-3.0-only
# Preserve ByteVC2's own MP4 sample entry/configuration; it is not vvc1/vvcC.
from pathlib import Path
import sys
root = Path(sys.argv[1]) / 'libavformat'
p = root / 'mov.c'; s = p.read_text()
needle = "{ MKTAG('v','v','c','C'), mov_read_glbl },"
assert needle in s
s = s.replace(needle, needle + "\n{ MKTAG('b','v','2','C'), mov_read_glbl },")
p.write_text(s)
p = root / 'movenc.c'; s = p.read_text()
needle = 'static const AVCodecTag codec_mp4_tags[] = {'
s = s.replace(needle, needle + "\n    { AV_CODEC_ID_BVC2, MKTAG('b', 'v', 'c', '2') },")
needle = '    } else if (track->par->codec_id == AV_CODEC_ID_VVC)\n        mov_write_vvcc_tag(pb, track);'
assert needle in s
s = s.replace(needle, '''    } else if (track->par->codec_id == AV_CODEC_ID_BVC2) {
        int size = track->extradata_size[track->last_stsd_index];
        avio_wb32(pb, size + 8);
        ffio_wfourcc(pb, "bv2C");
        avio_write(pb, track->extradata[track->last_stsd_index], size);
    } else if (track->par->codec_id == AV_CODEC_ID_VVC)
        mov_write_vvcc_tag(pb, track);''')
p.write_text(s)

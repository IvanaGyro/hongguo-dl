# SPDX-License-Identifier: GPL-3.0-only
# Scalar single-thread Emscripten port: initialize and compress synchronously.
# The caller must disable pools/WPP/lookahead and select exactly one frame thread.
from pathlib import Path
import sys
root = Path(sys.argv[1]) / 'source/encoder'
p = root / 'frameencoder.h'
s = p.read_text().replace('    void threadMain();', 'public:\n    void threadMain();\nprotected:')
p.write_text(s)
p = root / 'encoder.cpp'
s = p.read_text().replace('m_frameEncoder[i]->start();', 'm_frameEncoder[i]->threadMain();').replace('m_frameEncoder[i]->m_done.wait(); /* wait for thread to initialize */', '')
p.write_text(s)
p = root / 'frameencoder.cpp'; s = p.read_text()
s = s.replace('    m_enable.trigger();\n    return true;', '    compressFrame();\n    return true;')
a = s.index('    m_done.trigger();     /* signal that thread is initialized */')
b = s.index('\n}\n', a)
s = s[:a] + '    // Synchronous WASM port: startCompressFrame performs compression.\n' + s[b:]
s = s.replace('        m_done.wait();', '        /* Compression finished synchronously before this call. */')
p.write_text(s)

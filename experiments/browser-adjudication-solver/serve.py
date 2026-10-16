"""Loopback-only disposable static probe server. Only synthetic evidence is written."""
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
import json
ROOT=Path(__file__).resolve().parent
class Handler(SimpleHTTPRequestHandler):
    def __init__(self,*args,**kwargs): super().__init__(*args,directory=str(ROOT),**kwargs)
    def end_headers(self):
        self.send_header('Content-Security-Policy', "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'")
        self.send_header('Cache-Control','no-store')
        super().end_headers()
    def guess_type(self,path):
        if path.endswith('.wasm'): return 'application/wasm'
        if path.endswith('.mjs'): return 'text/javascript'
        return super().guess_type(path)
    def do_POST(self):
        size=int(self.headers.get('Content-Length',0))
        if self.path not in ['/evidence','/evidence/stress'] or not 0<size<512000: self.send_error(400); return
        result=json.loads(self.rfile.read(size))
        name='browser-stress-results.json' if self.path.endswith('/stress') else 'browser-results.json'
        (ROOT/name).write_text(json.dumps(result,indent=2)+'\n',encoding='utf8')
        self.send_response(200);self.end_headers();self.wfile.write(b'ok')
print('Synthetic probe listening on http://127.0.0.1:8769',flush=True)
ThreadingHTTPServer(('127.0.0.1',8769),Handler).serve_forever()

#!/usr/bin/env python3
"""
Portal upload SMART SEROK.

Server kecil tanpa dependency (stdlib saja) untuk mengirim file dari browser
user ke workspace agent.

Poin penting: tipe file dideteksi dari ISI (magic bytes), bukan dari nama.
Kasus `SMART_SEROK_v9.1.7.zip.txt` kemarin gagal karena penamaan; di sini file
seperti itu tetap dikenali sebagai ZIP dan diekstrak otomatis.

Jalankan:  python3 tools/upload_portal.py --port 8000
Hasil ada di: _incoming/
"""

import argparse
import cgi
import html
import io
import json
import os
import re
import shutil
import sys
import time
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
INCOMING = os.path.join(REPO_ROOT, "_incoming")
MAX_BYTES = 64 * 1024 * 1024  # 64 MB

# Nama file yang tidak berguna di dalam arsip.
JUNK = re.compile(r"(^|/)(__MACOSX/|\.DS_Store$|Thumbs\.db$)")


def safe_name(name):
    """Buang path traversal dan karakter aneh dari nama file."""
    name = os.path.basename((name or "").replace("\\", "/")).strip()
    name = re.sub(r"[^A-Za-z0-9._\- ()]+", "_", name)
    return name[:180] or "unnamed"


def unique_path(directory, name):
    """Jangan pernah menimpa file yang sudah ada."""
    base, ext = os.path.splitext(name)
    candidate = os.path.join(directory, name)
    n = 2
    while os.path.exists(candidate):
        candidate = os.path.join(directory, "{}_{}{}".format(base, n, ext))
        n += 1
    return candidate


def sniff(blob):
    """Deteksi tipe dari magic bytes, abaikan ekstensi."""
    if blob[:4] in (b"PK\x03\x04", b"PK\x05\x06", b"PK\x07\x08"):
        return "zip"
    if blob[:2] == b"\x1f\x8b":
        return "gzip"
    return "text" if is_texty(blob) else "binary"


def is_texty(blob):
    chunk = blob[:8192]
    if b"\x00" in chunk:
        return False
    try:
        chunk.decode("utf-8")
        return True
    except UnicodeDecodeError:
        return False


def extract_zip(blob, dest_dir):
    """Ekstrak ZIP dengan proteksi zip-slip. Return daftar file relatif."""
    written = []
    with zipfile.ZipFile(io.BytesIO(blob)) as zf:
        for info in zf.infolist():
            if info.is_dir() or JUNK.search(info.filename):
                continue
            parts = [p for p in info.filename.replace("\\", "/").split("/")
                     if p not in ("", ".", "..")]
            if not parts:
                continue
            rel = os.path.join(*[safe_name(p) for p in parts])
            target = os.path.join(dest_dir, rel)
            # Proteksi zip-slip: target wajib di dalam dest_dir.
            if not os.path.abspath(target).startswith(os.path.abspath(dest_dir) + os.sep):
                continue
            os.makedirs(os.path.dirname(target), exist_ok=True)
            with zf.open(info) as src, open(target, "wb") as dst:
                shutil.copyfileobj(src, dst)
            written.append(rel)
    return written


def handle_upload(filename, blob):
    """Simpan satu file upload. Return dict ringkasan untuk UI."""
    name = safe_name(filename)
    kind = sniff(blob)
    stamp = time.strftime("%Y%m%d-%H%M%S")

    if kind == "zip":
        # Buang ekstensi berlapis: "x.zip.txt" -> "x"
        folder = re.sub(r"(\.(zip|txt|gz|tar))+$", "", name, flags=re.I) or "archive"
        dest = unique_path(INCOMING, "{}__{}".format(stamp, safe_name(folder)))
        os.makedirs(dest, exist_ok=True)
        try:
            files = extract_zip(blob, dest)
        except zipfile.BadZipFile:
            kind = "binary"
        else:
            return {
                "name": name,
                "kind": "zip",
                "size": len(blob),
                "saved": os.path.relpath(dest, REPO_ROOT),
                "files": sorted(files),
                "note": "ZIP terdeteksi dari isi file dan sudah diekstrak.",
            }

    dest = unique_path(INCOMING, name)
    with open(dest, "wb") as fh:
        fh.write(blob)
    return {
        "name": name,
        "kind": kind,
        "size": len(blob),
        "saved": os.path.relpath(dest, REPO_ROOT),
        "files": [],
        "note": "",
    }


PAGE = """<!doctype html>
<html lang="id">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Portal Upload — SMART SEROK</title>
<style>
  *{box-sizing:border-box}
  body{margin:0;min-height:100vh;background:#0b1220;color:#e2e8f0;
       font:15px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;
       display:flex;align-items:flex-start;justify-content:center;padding:32px 16px}
  .wrap{width:100%;max-width:760px}
  h1{margin:0 0 6px;font-size:21px;letter-spacing:.2px}
  .sub{color:#94a3b8;font-size:13.5px;margin-bottom:22px}
  .sub code{background:#111c33;padding:1px 6px;border-radius:5px;color:#fbbf24;font-size:12.5px}
  #drop{border:2px dashed #334155;border-radius:14px;padding:46px 24px;text-align:center;
        background:#0f172a;transition:.18s;cursor:pointer}
  #drop:hover{border-color:#475569;background:#111c33}
  #drop.hot{border-color:#10b981;background:#0d2a22}
  .big{font-size:17px;font-weight:600;margin-bottom:6px}
  .hint{color:#64748b;font-size:13px}
  .btn{margin-top:16px;display:inline-block;background:#10b981;color:#04231a;border:0;
       padding:10px 22px;border-radius:9px;font-weight:700;font-size:14px;cursor:pointer}
  .btn:hover{background:#34d399}
  input[type=file]{display:none}
  #list{margin-top:22px;display:flex;flex-direction:column;gap:10px}
  .item{background:#0f172a;border:1px solid #1e293b;border-left-width:3px;
        border-radius:10px;padding:12px 14px}
  .item.ok{border-left-color:#10b981}
  .item.err{border-left-color:#ef4444}
  .item.run{border-left-color:#38bdf8}
  .row{display:flex;justify-content:space-between;gap:12px;align-items:baseline}
  .fn{font-weight:600;word-break:break-all;font-size:14px}
  .sz{color:#64748b;font-size:12px;white-space:nowrap}
  .meta{color:#94a3b8;font-size:12.5px;margin-top:5px}
  .meta b{color:#34d399;font-weight:600}
  .tree{margin:8px 0 0;padding:9px 11px;background:#0b1220;border-radius:7px;
        color:#94a3b8;font:12px ui-monospace,SFMono-Regular,Menlo,monospace;
        max-height:190px;overflow:auto;white-space:pre-wrap}
  .bar{height:3px;background:#1e293b;border-radius:2px;overflow:hidden;margin-top:9px}
  .bar i{display:block;height:100%;width:0;background:#38bdf8;transition:width .15s}
  .done{margin-top:20px;padding:13px 15px;background:#0d2a22;border:1px solid #10b981;
        border-radius:10px;color:#6ee7b7;font-size:13.5px;display:none}
  .done.on{display:block}
</style>
</head>
<body>
<div class="wrap">
  <h1>Portal Upload — SMART SEROK</h1>
  <div class="sub">
    File masuk ke <code>_incoming/</code>. Tipe dideteksi dari isi file, bukan namanya —
    jadi <code>.zip.txt</code> tetap dikenali sebagai ZIP dan diekstrak otomatis.
  </div>

  <div id="drop">
    <div class="big">Tarik file ke sini</div>
    <div class="hint">atau klik untuk memilih · bisa banyak file sekaligus · maks 64 MB</div>
    <button class="btn" type="button" id="pick">Pilih File</button>
    <input type="file" id="file" multiple>
  </div>

  <div id="list"></div>
  <div class="done" id="done">Selesai. Bilang <b>"sudah"</b> di chat, saya langsung baca filenya.</div>
</div>

<script>
const drop=document.getElementById('drop'), inp=document.getElementById('file'),
      list=document.getElementById('list'), done=document.getElementById('done');

document.getElementById('pick').onclick=e=>{e.stopPropagation();inp.click()};
drop.onclick=()=>inp.click();
inp.onchange=()=>{send([...inp.files]);inp.value=''};

['dragenter','dragover'].forEach(t=>drop.addEventListener(t,e=>{
  e.preventDefault();drop.classList.add('hot')}));
['dragleave','drop'].forEach(t=>drop.addEventListener(t,e=>{
  e.preventDefault();drop.classList.remove('hot')}));
drop.addEventListener('drop',e=>send([...e.dataTransfer.files]));

const kb=n=>n<1024?n+' B':n<1048576?(n/1024).toFixed(1)+' KB':(n/1048576).toFixed(2)+' MB';

function send(files){
  files.forEach(f=>{
    const el=document.createElement('div');
    el.className='item run';
    el.innerHTML=`<div class="row"><span class="fn"></span><span class="sz">${kb(f.size)}</span></div>
                  <div class="meta">mengirim…</div><div class="bar"><i></i></div>`;
    el.querySelector('.fn').textContent=f.name;
    list.prepend(el);

    const fd=new FormData(); fd.append('file',f,f.name);
    const xhr=new XMLHttpRequest();
    xhr.open('POST','/upload');
    xhr.upload.onprogress=e=>{
      if(e.lengthComputable) el.querySelector('.bar i').style.width=(e.loaded/e.total*100)+'%';
    };
    xhr.onload=()=>{
      el.querySelector('.bar').remove();
      let r={};
      try{ r=JSON.parse(xhr.responseText) }catch(_){}
      if(xhr.status===200 && r.ok){
        el.className='item ok';
        const m=el.querySelector('.meta');
        m.innerHTML=`tersimpan → <b></b>`;
        m.querySelector('b').textContent=r.saved;
        if(r.note) m.insertAdjacentText('beforeend',' · '+r.note);
        if(r.files && r.files.length){
          const t=document.createElement('div');
          t.className='tree';
          t.textContent=r.files.length+' file diekstrak:\\n'+r.files.join('\\n');
          el.appendChild(t);
        }
        done.classList.add('on');
      }else{
        el.className='item err';
        el.querySelector('.meta').textContent='GAGAL — '+(r.error||('HTTP '+xhr.status));
      }
    };
    xhr.onerror=()=>{
      el.className='item err';
      el.querySelector('.meta').textContent='GAGAL — koneksi terputus';
    };
    xhr.send(fd);
  });
}
</script>
</body>
</html>
"""


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        sys.stderr.write("  %s\n" % (fmt % args))

    def _send(self, code, body, ctype):
        if isinstance(body, str):
            body = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.split("?")[0] in ("/", "/index.html"):
            self._send(200, PAGE, "text/html; charset=utf-8")
        else:
            self._send(404, "not found", "text/plain; charset=utf-8")

    def do_POST(self):
        if self.path.split("?")[0] != "/upload":
            self._send(404, json.dumps({"ok": False, "error": "route tidak dikenal"}),
                       "application/json")
            return

        try:
            length = int(self.headers.get("Content-Length") or 0)
            if length <= 0:
                raise ValueError("body kosong")
            if length > MAX_BYTES:
                raise ValueError("file melebihi 64 MB")

            form = cgi.FieldStorage(
                fp=self.rfile,
                headers=self.headers,
                environ={"REQUEST_METHOD": "POST",
                         "CONTENT_TYPE": self.headers.get("Content-Type", "")},
            )
            if "file" not in form:
                raise ValueError("field 'file' tidak ada")

            item = form["file"]
            blob = item.file.read() if item.file else (item.value or b"")
            if not blob:
                raise ValueError("file kosong")

            os.makedirs(INCOMING, exist_ok=True)
            result = handle_upload(item.filename or "unnamed", blob)
            result["ok"] = True

            print("  [OK] {} ({}) -> {}".format(
                result["name"], result["kind"], result["saved"]), flush=True)
            self._send(200, json.dumps(result), "application/json")

        except Exception as exc:  # noqa: BLE001 - dilaporkan ke UI
            print("  [ERR] {}".format(exc), flush=True)
            self._send(400, json.dumps({"ok": False, "error": str(exc)}),
                       "application/json")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--host", default="0.0.0.0")
    args = ap.parse_args()

    os.makedirs(INCOMING, exist_ok=True)
    print("Portal upload SMART SEROK")
    print("  listen : http://{}:{}".format(args.host, args.port))
    print("  tujuan : {}".format(INCOMING), flush=True)
    ThreadingHTTPServer((args.host, args.port), Handler).serve_forever()


if __name__ == "__main__":
    main()

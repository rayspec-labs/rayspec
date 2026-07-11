#!/usr/bin/env python3
"""A tiny demo UI for the Support-Ticket backend (YAML-only, no product code).

Serves a single-page ticket UI AND proxies its /api/* calls to the running RaySpec backend
(default http://127.0.0.1:8791) with a bearer token it mints itself (login + org-switch, refreshed on
401). Same-origin from the browser's view → no CORS, and the token never touches the page. Stdlib only.

    python3 examples/support-ticket-triage/demo-ui.py      # then open http://127.0.0.1:8080

Prereqs (see this dir's README): the backend running (`dev-boot.mjs`), and a user that is an owner of
the deployment tenant + a seeded routing_policies catalog. LOCAL / trusted posture / NOT internet-facing.

Env (all optional):
    RAYSPEC_URL   default http://127.0.0.1:8791       DEMO_PORT      default 8080
    TENANT_ID      default 00000000-0000-4000-8000-000000000042
    DEMO_EMAIL     default me@play.local               DEMO_PASSWORD  default a-long-enough-password
"""
import json
import os
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

RAYSPEC = os.environ.get("RAYSPEC_URL", "http://127.0.0.1:8791")
TENANT = os.environ.get("TENANT_ID", "00000000-0000-4000-8000-000000000042")
EMAIL = os.environ.get("DEMO_EMAIL", "me@play.local")
PASSWORD = os.environ.get("DEMO_PASSWORD", "a-long-enough-password")
DEMO_PORT = int(os.environ.get("DEMO_PORT", "8080"))

_token = {"v": None}


def _req(method, url, token=None, body=None):
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(url, data=data, method=method)
    r.add_header("content-type", "application/json")
    if token:
        r.add_header("authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(r, timeout=15) as resp:
            return resp.status, resp.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


def mint_token():
    st, b = _req("POST", f"{RAYSPEC}/v1/auth/login", body={"email": EMAIL, "password": PASSWORD})
    if st != 200:
        raise RuntimeError(f"login failed {st}: {b!r}")
    reg = json.loads(b)["accessToken"]
    st, b = _req("POST", f"{RAYSPEC}/v1/orgs/{TENANT}/switch", token=reg)
    if st != 200:
        raise RuntimeError(f"switch failed {st}: {b!r}")
    _token["v"] = json.loads(b)["accessToken"]
    return _token["v"]


def proxy(method, path, body=None):
    """Proxy to the backend, minting/refreshing the token on 401."""
    tok = _token["v"] or mint_token()
    st, b = _req(method, f"{RAYSPEC}{path}", token=tok, body=body)
    if st == 401:
        tok = mint_token()
        st, b = _req(method, f"{RAYSPEC}{path}", token=tok, body=body)
    return st, b


PAGE = """<!doctype html><html lang="de"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Support Tickets — YAML-only Backend</title>
<style>
  :root { color-scheme: light dark; --bg:#f6f7f9; --card:#fff; --line:#e3e6ea; --ink:#1a1d21; --mut:#6b7280; --accent:#2563eb; }
  @media (prefers-color-scheme:dark){ :root{ --bg:#0f1214; --card:#181c20; --line:#2a2f36; --ink:#e8eaed; --mut:#9aa3ad; --accent:#5b9dff; } }
  * { box-sizing:border-box; } body{ margin:0; font:15px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif; background:var(--bg); color:var(--ink); }
  header{ padding:18px 22px; border-bottom:1px solid var(--line); display:flex; align-items:baseline; gap:12px; flex-wrap:wrap; }
  header h1{ font-size:18px; margin:0; } header .tag{ font-size:12px; color:var(--mut); background:var(--card); border:1px solid var(--line); border-radius:99px; padding:2px 10px; }
  main{ max-width:920px; margin:0 auto; padding:22px; display:grid; grid-template-columns:1fr 1.3fr; gap:22px; }
  @media (max-width:760px){ main{ grid-template-columns:1fr; } }
  .card{ background:var(--card); border:1px solid var(--line); border-radius:12px; padding:18px; }
  h2{ font-size:13px; text-transform:uppercase; letter-spacing:.04em; color:var(--mut); margin:0 0 14px; }
  label{ display:block; font-size:12px; color:var(--mut); margin:10px 0 4px; }
  input,select,textarea{ width:100%; padding:9px 10px; border:1px solid var(--line); border-radius:8px; background:var(--bg); color:var(--ink); font:inherit; }
  textarea{ resize:vertical; min-height:60px; }
  button{ margin-top:14px; width:100%; padding:10px; border:0; border-radius:8px; background:var(--accent); color:#fff; font:inherit; font-weight:600; cursor:pointer; }
  button:disabled{ opacity:.5; cursor:default; }
  .list{ display:flex; flex-direction:column; gap:10px; }
  .ticket{ border:1px solid var(--line); border-radius:10px; padding:12px 14px; cursor:pointer; transition:border-color .12s; }
  .ticket:hover{ border-color:var(--accent); }
  .ticket .top{ display:flex; justify-content:space-between; gap:10px; align-items:center; }
  .ref{ font:12px ui-monospace,SFMono-Regular,Menlo,monospace; color:var(--mut); }
  .pill{ font-size:11px; padding:2px 8px; border-radius:99px; border:1px solid var(--line); }
  .pill.billing{ color:#b45309; border-color:#f59e0b55; } .pill.auth{ color:#7c3aed; border-color:#8b5cf655; }
  .subj{ font-weight:600; margin-top:6px; }
  .route{ font-size:12px; color:var(--mut); margin-top:6px; }
  .empty{ color:var(--mut); font-size:13px; padding:8px 0; }
  .flash{ font-size:12px; color:var(--mut); min-height:16px; margin-top:8px; }
</style></head><body>
<header>
  <h1>&#127915; Support Tickets</h1>
  <span class="tag">l&auml;uft auf einem YAML-only RaySpec-Backend &middot; kein Produktcode</span>
</header>
<main>
  <section class="card">
    <h2>Neues Ticket</h2>
    <label>E-Mail des Anfragenden</label>
    <input id="email" value="user@acme.example">
    <label>Betreff</label>
    <input id="subject" value="Zahlung fehlgeschlagen">
    <label>Beschreibung</label>
    <textarea id="body">Meine Karte wird beim Checkout abgelehnt.</textarea>
    <label>Bereich (routet zum Team)</label>
    <select id="area"><option value="billing">billing</option><option value="auth">auth</option></select>
    <button id="submit" onclick="submitTicket()">Ticket einreichen &rarr;</button>
    <div class="flash" id="flash"></div>
  </section>
  <section class="card">
    <h2>Tickets <span id="count" class="ref"></span></h2>
    <div class="list" id="list"><div class="empty">lade&hellip;</div></div>
  </section>
</main>
<script>
async function api(method, path, body){
  const r = await fetch('/api'+path, {method, headers:{'content-type':'application/json'}, body: body?JSON.stringify(body):undefined});
  return {status:r.status, json: await r.json().catch(()=>({}))};
}
async function refresh(){
  const {json} = await api('GET','/tickets');
  const list = document.getElementById('list'); const tickets = json.tickets||[];
  document.getElementById('count').textContent = tickets.length ? '('+tickets.length+')' : '';
  if(!tickets.length){ list.innerHTML='<div class="empty">Noch keine Tickets &mdash; reich links eins ein.</div>'; return; }
  list.innerHTML='';
  for(const t of tickets){
    const el=document.createElement('div'); el.className='ticket';
    el.innerHTML='<div class="top"><span class="ref">'+t.ticket_ref+'</span><span class="pill '+t.product_area+'">'+t.product_area+'</span></div>'
      +'<div class="route" id="r-'+t.ticket_ref+'">'+(t.status||'')+' &middot; Team l&auml;dt&hellip;</div>';
    el.onclick=()=>showDetail(t.ticket_ref);
    list.appendChild(el);
    showDetail(t.ticket_ref, true);
  }
}
async function showDetail(ref, quiet){
  const {json} = await api('GET','/tickets/'+ref);
  const route = (json.routing&&json.routing[0]) || {};
  const line = (json.status||'?')+' &middot; '+(route.owning_team? '&rarr; '+route.owning_team+' ('+route.default_priority+')' : 'kein Routing');
  const el = document.getElementById('r-'+ref); if(el) el.innerHTML = line;
  if(!quiet) document.getElementById('flash').innerHTML = ref+': '+(json.subject||'')+' &mdash; '+line;
}
async function submitTicket(){
  const btn=document.getElementById('submit'); btn.disabled=true;
  const flash=document.getElementById('flash'); flash.textContent='reiche ein…';
  const body={ requester_email:email.value, subject:subject.value, body:document.getElementById('body').value, product_area:area.value };
  const {status,json}=await api('POST','/submit',body);
  if(status===200){ flash.textContent='✓ '+json.record_id+' eingereicht'+(json.deduped?' (dedup)':'')+' — Workflow läuft…'; }
  else { flash.textContent='⚠ '+status+': '+(json.error||JSON.stringify(json)); }
  btn.disabled=false;
  setTimeout(refresh, 800); setTimeout(refresh, 2200);
}
refresh(); setInterval(refresh, 5000);
</script></body></html>"""


class H(BaseHTTPRequestHandler):
    def _send(self, status, body, ctype="application/json"):
        self.send_response(status)
        self.send_header("content-type", ctype)
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):
        pass

    def do_GET(self):
        if self.path == "/" or self.path.startswith("/index"):
            return self._send(200, PAGE.encode(), "text/html; charset=utf-8")
        if self.path == "/api/tickets":
            st, b = proxy("GET", "/tickets")
            return self._send(st, b)
        if self.path.startswith("/api/tickets/"):
            ref = self.path[len("/api/tickets/"):]
            st, b = proxy("GET", f"/tickets/{ref}")
            return self._send(st, b)
        return self._send(404, b'{"error":"not_found"}')

    def do_POST(self):
        if self.path == "/api/submit":
            n = int(self.headers.get("content-length", 0))
            payload = json.loads(self.rfile.read(n) or b"{}")
            rec = f"TICKET-{int(time.time() * 1000)}"
            st, b = proxy("POST", f"/records/{rec}/submit", body=payload)
            return self._send(st, b)
        return self._send(404, b'{"error":"not_found"}')


if __name__ == "__main__":
    try:
        mint_token()
        print(f"[demo-ui] token ok — backend {RAYSPEC}")
    except Exception as e:  # noqa: BLE001 — best-effort at startup; per-request retry covers it
        print(f"[demo-ui] WARN could not mint token yet ({e}); will retry per request")
    print(f"[demo-ui] open  http://127.0.0.1:{DEMO_PORT}")
    ThreadingHTTPServer(("127.0.0.1", DEMO_PORT), H).serve_forever()

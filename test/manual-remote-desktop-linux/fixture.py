"""Loopback-only example site, started inside each worker's private network namespace."""
from http.server import BaseHTTPRequestHandler, HTTPServer


START_PAGES = {
    "/start/alpha": ("demo=alpha; HttpOnly; SameSite=Strict; Path=/; Max-Age=3600", "/work/alpha"),
    "/start/bravo": ("demo=bravo; HttpOnly; SameSite=Strict; Path=/; Max-Age=3600", "/work/bravo"),
}
PAGES = {f"/{action}/{account}": account for action in ("work", "detail") for account in ("alpha", "bravo")}


class Fixture(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_GET(self):
        start = START_PAGES.get(self.path)
        if start:
            cookie, location = start
            self.send_response(303)
            self.send_header("Set-Cookie", cookie)
            self.send_header("Location", location)
            self.end_headers()
            return
        account = PAGES.get(self.path)
        if account is None:
            self.send_error(404)
            return
        signed_in = self.headers.get("Cookie") == "demo=" + account
        page = """<!doctype html><meta charset=utf-8><style>html,body{margin:0;height:100%}
        h1{margin:0;color:white;font:36px sans-serif}</style><h1></h1><input id="note" aria-label="Test note" autofocus placeholder="Type a test note"><script>
        const account=ACCOUNT, signedIn=SIGNED_IN, detail=location.pathname.startsWith("/detail/");
        const previous=history.state?.path === location.pathname;
        if (!previous) history.replaceState({path:location.pathname}, "");
        let saved=localStorage.getItem("completed") === account;
        function draw() {
          document.body.style.background = !signedIn ? "#51454b" :
            detail ? (previous ? "#bf9032" : "#977724") : note.value === "q" ? "#59399d" : saved ? "#266cca" : account === "alpha" ? "#24ae70" : "#c16d22";
          document.querySelector("h1").textContent= signedIn ? account+" / "+(saved?"completed":"pending") : "Sign in required";
        }
        // A fresh navigation must not pass the restored-tab check after the browser is exited.
        if (saved && !previous) saved=false;
        const note=document.getElementById("note");
        note.addEventListener("input",draw);
        document.body.onclick=()=>{if(signedIn){localStorage.setItem("completed",account);saved=true;note.focus();draw()}};
        draw();
        </script>""".replace("ACCOUNT", repr(account)).replace("SIGNED_IN", str(signed_in).lower())
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(page.encode())


HTTPServer(("127.0.0.1", 18112), Fixture).serve_forever()

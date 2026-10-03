// Builds a static GitHub Pages demo of InvoiceLite by snapshotting the
// locally running app (http://localhost:4173) with a logged-in session.
const BASE = "http://localhost:4173";
const OUT = "C:/Users/Hello/.zcode/workspace/default/invoicelite-pages-demo";
const EMAIL = "maya@riverastudio.example";
const PASSWORD = "PortfolioDemo2026!";

const fs = await import("node:fs/promises");
const path = await import("node:path");

// --- login ----------------------------------------------------------------
let cookie = "";
const loginPage = await fetch(`${BASE}/login`);
for (const c of loginPage.headers.getSetCookie()) {
  cookie += c.split(";")[0] + "; ";
}
const loginHtml = await loginPage.text();
const csrf = loginHtml.match(/name="_csrf" value="([^"]+)"/)?.[1];
if (!csrf) throw new Error("no csrf token on login page");

const loginRes = await fetch(`${BASE}/login`, {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookie },
  body: new URLSearchParams({ _csrf: csrf, email: EMAIL, password: PASSWORD }),
  redirect: "manual",
});
cookie += (loginRes.headers.getSetCookie() || []).map((c) => c.split(";")[0]).join("; ") + "; ";
console.log("login status:", loginRes.status);
if (loginRes.status !== 302 && loginRes.status !== 303) throw new Error("login failed");

const get = async (p) => {
  const res = await fetch(`${BASE}${p}`, { headers: { Cookie: cookie } });
  const html = await res.text();
  if (res.status !== 200) throw new Error(`${p} -> ${res.status}`);
  return html;
};

// --- pages to capture -------------------------------------------------------
const pages = {
  "login.html": await (async () => {
    // fresh logged-out login page (logged-in GET /login would redirect)
    const res = await fetch(`${BASE}/login`);
    return await res.text();
  })(),
  "dashboard.html": await get("/dashboard"),
  "invoices.html": await get("/invoices"),
  "invoice-1.html": await get("/invoices/1"),
  "invoice-2.html": await get("/invoices/2"),
  "invoice-new.html": await get("/invoices/new"),
  "customers.html": await get("/customers"),
  "customer-new.html": await get("/customers/new"),
  "business.html": await get("/business"),
};

// --- rewrite ----------------------------------------------------------------
const BANNER = `
<div id="static-demo-banner">
  This is a <b>static demo</b> of InvoiceLite — the data is sample only and forms don't submit.
  <a href="https://github.com/Whis360/invoicelite" target="_blank" rel="noopener">View the source</a>
</div>
<style>
  #static-demo-banner {
    position: sticky; top: 0; z-index: 9999;
    background: #1e1b4b; color: #e0e7ff;
    font: 13px/1.4 system-ui, sans-serif;
    text-align: center; padding: 8px 16px;
  }
  #static-demo-banner a { color: #a5b4fc; font-weight: 600; }
</style>
`;

function rewrite(html) {
  return html
    // static demo banner right after <body>
    .replace(/<body([^>]*)>/, `<body$1>${BANNER}`)
    // assets
    .replace(/href="\/styles\.css"/g, 'href="styles.css"')
    .replace(/src="\/js\//g, 'src="js/')
    // app links (exact href matches, most specific paths first)
    .replace(/href="\/dashboard"/g, 'href="dashboard.html"')
    .replace(/href="\/invoices\/new"/g, 'href="invoice-new.html"')
    .replace(/href="\/invoices\/(\d+)\/edit"/g, 'href="#"')
    .replace(/href="\/invoices\/(\d+)\/pdf"/g, 'href="#"')
    .replace(/href="\/invoices\/(\d+)\/receipt"/g, 'href="#"')
    .replace(/href="\/invoices\/(\d+)"/g, 'href="invoice-$1.html"')
    .replace(/href="\/invoices"/g, 'href="invoices.html"')
    .replace(/href="\/customers\/new"/g, 'href="customer-new.html"')
    .replace(/href="\/customers\/(\d+)\/edit"/g, 'href="#"')
    .replace(/href="\/customers\/(\d+)"/g, 'href="customers.html"')
    .replace(/href="\/customers"/g, 'href="customers.html"')
    .replace(/href="\/business"/g, 'href="business.html"')
    .replace(/href="\/login"/g, 'href="login.html"')
    .replace(/href="\/logout"/g, 'href="login.html"')
    // forms and anything else that needs a server become inert
    .replace(/action="\/[^"]*"/g, 'action="#"')
    // any remaining absolute app links just go to the dashboard
    .replace(/href="\/(?!\/)[^"]*"/g, 'href="dashboard.html"');
}

await fs.mkdir(OUT, { recursive: true });
await fs.mkdir(path.join(OUT, "js"), { recursive: true });

for (const [name, html] of Object.entries(pages)) {
  await fs.writeFile(path.join(OUT, name), rewrite(html));
  console.log("wrote", name);
}
// dashboard doubles as the entry page
await fs.copyFile(path.join(OUT, "dashboard.html"), path.join(OUT, "index.html"));

// static assets
await fs.copyFile("C:/Users/Hello/.zcode/workspace/default/invoicelite/public/styles.css", path.join(OUT, "styles.css"));
for (const f of await fs.readdir("C:/Users/Hello/.zcode/workspace/default/invoicelite/public/js")) {
  await fs.copyFile(`C:/Users/Hello/.zcode/workspace/default/invoicelite/public/js/${f}`, path.join(OUT, "js", f));
}
await fs.writeFile(path.join(OUT, ".nojekyll"), "");
console.log("done ->", OUT);

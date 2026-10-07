// This renderer has no filesystem, network, or Node.js access.
const fields = [
  ["country", "Country"], ["country_iso", "Country code"], ["country_ir", "In Iran"],
  ["city", "City"], ["region_name", "Region"], ["region_code", "Region code"],
  ["postal_code", "Postal code"], ["timezone", "Time zone"],
  ["latitude", "Latitude"], ["longitude", "Longitude"], ["asn", "ASN"], ["asn_org", "Network"], ["hostname", "Reverse DNS"],
];
const $ = (id) => document.getElementById(id);
let report;
let busy = false;
const media = matchMedia("(prefers-color-scheme: dark)");
const theme = () => { document.documentElement.dataset.theme = media.matches ? "bea-dark" : "bea"; };
theme(); media.addEventListener("change", theme);

function element(tag, classes, text) {
  const node = document.createElement(tag);
  node.className = classes;
  if (text !== undefined) node.textContent = String(text);
  return node;
}

function render(next) {
  report = next;
  $("results").replaceChildren();
  $("status").textContent = next.message;
  for (const { host, data, error } of next.visible) {
    const card = element("section", "card card-border bg-base-100 min-w-0");
    card.dataset.host = host;
    const body = element("div", "card-body");
    body.append(element("h2", "card-title text-lg", host));
    if (data) {
      body.append(element("p", "my-2 break-all font-mono text-2xl font-semibold", data.ip));
      const list = element("dl", "grid grid-cols-[auto_1fr] gap-x-5 gap-y-3 text-sm");
      for (const [key, title] of fields) {
        if (data[key] === undefined || data[key] === null || data[key] === "") continue;
        list.append(element("dt", "text-base-content/70", title), element("dd", "break-words min-w-0", typeof data[key] === "boolean" ? data[key] ? "Yes" : "No" : data[key]));
      }
      body.append(list);
    } else body.append(element("p", "alert alert-error my-3", error));
    const open = element("button", "btn btn-sm mt-4 self-start", "Open service");
    open.addEventListener("click", () => window.ipinfo.open(host).catch(() => { $("status").textContent = "Could not open the browser."; }));
    body.append(open); card.append(body); $("results").append(card);
  }
  $("copy").disabled = false;
}

async function lookup() {
  if (busy) return;
  busy = true;
  $("refresh").disabled = true; $("current").disabled = true; $("copy").disabled = true;
  $("status").textContent = "Checking both services…";
  try {
    await window.ipinfo.saveSettings({ source: $("source").value, timeout: Number($("timeout").value) });
  } catch {
    $("status").textContent = "Could not save settings. Choose a source and a timeout from 1 to 30 seconds.";
    busy = false; $("refresh").disabled = false; $("current").disabled = false; $("copy").disabled = !report;
    return;
  }
  try { render(await window.ipinfo.check($("address").value.trim() || undefined)); }
  catch { $("status").textContent = "Enter a valid IPv4 or IPv6 address and try again."; $("copy").disabled = !report; }
  finally { busy = false; $("refresh").disabled = false; $("current").disabled = false; }
}
$("lookup").addEventListener("submit", (event) => { event.preventDefault(); lookup(); });
$("current").addEventListener("click", () => { $("address").value = ""; lookup(); });
$("copy").addEventListener("click", async () => {
  if (!report) return;
  try {
    await window.ipinfo.copy(JSON.stringify(Object.fromEntries(report.visible.map(({ host, data, error }) => [host, data ?? { error }])), null, 2));
    $("status").textContent = "Results copied.";
  } catch { $("status").textContent = "Could not copy the results."; }
});
$("save").addEventListener("click", async () => {
  try {
    await window.ipinfo.saveSettings({ source: $("source").value, timeout: Number($("timeout").value) });
    $("status").textContent = "Settings saved for the app and command line.";
  } catch { $("status").textContent = "Could not save settings. Choose a source and a timeout from 1 to 30 seconds."; }
});
window.ipinfo.settings().then((settings) => {
  $("source").value = settings.source; $("timeout").value = settings.timeout; lookup();
}).catch(() => { $("status").textContent = "Could not read IPinfo settings. Fix or remove the settings file."; });

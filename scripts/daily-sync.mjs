// Run from a server timer; credentials stay in the process environment.
const url = process.env.INVENTORY_SITE_URL;
const secret = process.env.INVENTORY_CRON_SECRET;
if (!url || !secret || secret.length < 32) throw new Error("Configure INVENTORY_SITE_URL and INVENTORY_CRON_SECRET on the server.");
const target = new URL("/api/scheduled-sync", url);
if (target.protocol !== "https:" && !["localhost","127.0.0.1"].includes(target.hostname)) throw new Error("Use HTTPS for the inventory server.");
const headers = { Authorization: `Bearer ${secret}` };
if (process.env.SITES_SERVICE_TOKEN) headers["OAI-Sites-Authorization"] = `Bearer ${process.env.SITES_SERVICE_TOKEN}`;
const response = await fetch(target,{method:"POST",headers,signal:AbortSignal.timeout(600_000)});
if (!response.ok) throw new Error(`Inventory sync returned HTTP ${response.status}`);
const data = await response.json();
for (const result of data.results || []) console.log(`${result.warehouseCode}: ${result.status}${result.goodsCount !== undefined ? `, ${result.goodsCount} goods` : ""}`);
if (data.skipped || (data.results || []).some(r => r.status === "failed")) process.exitCode = 1;

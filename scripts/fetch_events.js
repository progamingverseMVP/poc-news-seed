const fetch  = require("node-fetch");
const xml2js = require("xml2js");
const fs     = require("fs");
const path   = require("path");

const FF_THIS_WEEK = "https://nfs.faireconomy.media/ff_calendar_thisweek.xml";
const FF_NEXT_WEEK = "https://nfs.faireconomy.media/ff_calendar_nextweek.xml";
const OUTPUT_PATH  = path.join(__dirname, "../data/news_events.csv");
const MAX_EVENTS   = 12;

const HEADERS = {
    "User-Agent":      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Accept":          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.5",
    "Accept-Encoding": "gzip, deflate, br",
    "Connection":      "keep-alive",
    "Cache-Control":   "no-cache",
};

async function fetchWithRetry(url, attempts = 3) {
    for (let i = 0; i < attempts; i++) {
        try {
            console.log(`  fetching (attempt ${i + 1}): ${url}`);
            const res = await fetch(url, { headers: HEADERS, timeout: 30000 });
            if (res.ok) {
                const text = await res.text();
                return xml2js.parseStringPromise(text, { explicitArray: false });
            }
            console.warn(`  HTTP ${res.status} on attempt ${i + 1}`);
        } catch (err) {
            console.warn(`  error on attempt ${i + 1}: ${err.message}`);
        }
        if (i < attempts - 1) await new Promise(r => setTimeout(r, 5000));
    }
    return null;
}

function toUtcMs(dateStr, timeStr) {
    const [month, day, year] = dateStr.split("-").map(Number);
    let hours = 0, minutes = 0;
    if (timeStr && timeStr.trim() !== "") {
        const t    = timeStr.trim().toLowerCase();
        const isPM = t.endsWith("pm");
        const isAM = t.endsWith("am");
        const [h, m] = t.replace("am","").replace("pm","").split(":").map(Number);
        hours   = isPM && h !== 12 ? h + 12 : (isAM && h === 12 ? 0 : h);
        minutes = m || 0;
    }
    const isDST     = month >= 3 && month <= 11;
    const offsetHrs = isDST ? 4 : 5;
    const localMs   = Date.UTC(year, month - 1, day, hours, minutes, 0);
    return localMs + offsetHrs * 60 * 60 * 1000;
}

function extractEvents(parsed) {
    if (!parsed) return [];
    const items = parsed?.root?.channel?.item;
    if (!items) return [];
    const arr   = Array.isArray(items) ? items : [items];
    const now   = Date.now();
    const in14d = now + 14 * 24 * 60 * 60 * 1000;

    return arr.reduce((results, item) => {
        if (item?.currency !== "USD")  return results;
        if (item?.impact   !== "High") return results;
        if (!item?.date)               return results;

        const utcMs = toUtcMs(item.date, item.time || "");
        if (utcMs < now - 60 * 60 * 1000) return results;
        if (utcMs > in14d)               return results;

        results.push({
            title:     item.title || "Unknown",
            timestamp: Math.floor(utcMs / 1000),
            date:      new Date(utcMs).toISOString(),
        });
        return results;
    }, []);
}

function writeCSV(events) {
    while (events.length < MAX_EVENTS) events.push({ timestamp: 0, title: "empty" });

    const header = "time,open,high,low,close,volume";
    const rows   = events.map((e, i) => {
        const ts      = e.timestamp;
        const baseMs  = Date.UTC(2020, 0, 1) + i * 24 * 60 * 60 * 1000;
        const dateStr = new Date(baseMs).toISOString().split("T")[0];
        return `${dateStr},${ts},${ts},${ts},${ts},1`;
    });

    const csv = [header, ...rows].join("\n") + "\n";
    fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
    fs.writeFileSync(OUTPUT_PATH, csv, "utf8");
    console.log(`[fetch_events] wrote ${OUTPUT_PATH}`);
}

async function main() {
    console.log("[fetch_events] starting...");

    let allEvents = [];
    for (const url of [FF_THIS_WEEK, FF_NEXT_WEEK]) {
        const parsed = await fetchWithRetry(url);
        if (parsed) {
            const events = extractEvents(parsed);
            allEvents    = allEvents.concat(events);
            console.log(`  got ${events.length} events from ${url}`);
        } else {
            console.warn(`  skipping ${url} — all attempts failed`);
        }
    }

    if (allEvents.length === 0) {
        console.warn("[fetch_events] no events fetched — writing blank CSV as fallback");
        writeCSV([]);
        console.log("[fetch_events] done (blank fallback).");
        return;
    }

    const seen   = new Set();
    const unique = allEvents
        .filter(e => { if (seen.has(e.timestamp)) return false; seen.add(e.timestamp); return true; })
        .sort((a, b) => a.timestamp - b.timestamp)
        .slice(0, MAX_EVENTS);

    console.log(`[fetch_events] found ${unique.length} high-impact USD events:`);
    unique.forEach(e => console.log(`  ${e.date}  ${e.title}  (${e.timestamp})`));

    writeCSV(unique);
    console.log("[fetch_events] done.");
}

main().catch(err => {
    console.error("[fetch_events] FATAL:", err);
    process.exit(1);
});

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
    "Connection":      "keep-alive",
    "Cache-Control":   "no-cache",
};

async function fetchRaw(url) {
    console.log(`  fetching: ${url}`);
    const res = await fetch(url, { headers: HEADERS, timeout: 30000 });
    console.log(`  status: ${res.status}`);
    const text = await res.text();
    // Print first 2000 chars so we can see what came back
    console.log(`  raw response (first 2000 chars):\n${text.slice(0, 2000)}`);
    return { ok: res.ok, text };
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

    // Debug: print the top-level keys so we can see the structure
    console.log("  parsed keys:", Object.keys(parsed));

    // Try both common FF XML structures
    const channel = parsed?.root?.channel
                 || parsed?.rss?.channel
                 || parsed?.feed;

    if (!channel) {
        console.warn("  WARNING: could not find channel in parsed XML");
        console.log("  full parsed object:", JSON.stringify(parsed).slice(0, 1000));
        return [];
    }

    const items = channel?.item || channel?.entry;
    if (!items) {
        console.warn("  WARNING: no items found in channel");
        console.log("  channel keys:", Object.keys(channel));
        return [];
    }

    const arr   = Array.isArray(items) ? items : [items];
    console.log(`  total items in feed: ${arr.length}`);

    // Print first item so we can see the field names
    if (arr.length > 0) {
        console.log("  first item sample:", JSON.stringify(arr[0]).slice(0, 500));
    }

    const now   = Date.now();
    const in14d = now + 14 * 24 * 60 * 60 * 1000;

    return arr.reduce((results, item) => {
        // Debug each item's currency and impact
        const currency = item?.currency;
        const impact   = item?.impact;

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
        try {
            const { ok, text } = await fetchRaw(url);
            if (!ok) {
                console.warn(`  skipping — bad status`);
                continue;
            }
            const parsed = await xml2js.parseStringPromise(text, { explicitArray: false });
            const events = extractEvents(parsed);
            console.log(`  extracted ${events.length} matching events`);
            allEvents = allEvents.concat(events);
        } catch (err) {
            console.warn(`  ERROR: ${err.message}`);
        }
    }

    if (allEvents.length === 0) {
        console.warn("[fetch_events] no events found — writing blank CSV");
        writeCSV([]);
        return;
    }

    const seen   = new Set();
    const unique = allEvents
        .filter(e => { if (seen.has(e.timestamp)) return false; seen.add(e.timestamp); return true; })
        .sort((a, b) => a.timestamp - b.timestamp)
        .slice(0, MAX_EVENTS);

    console.log(`[fetch_events] writing ${unique.length} events to CSV`);
    unique.forEach(e => console.log(`  ${e.date}  ${e.title}  (${e.timestamp})`));

    writeCSV(unique);
    console.log("[fetch_events] done.");
}

main().catch(err => {
    console.error("[fetch_events] FATAL:", err);
    process.exit(1);
});

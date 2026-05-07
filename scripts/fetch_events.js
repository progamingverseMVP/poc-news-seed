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
    if (!res.ok) {
        console.warn(`  skipping — HTTP ${res.status}`);
        return null;
    }
    const text = await res.text();
    return text;
}

function toUtcMs(dateStr, timeStr) {
    // dateStr: "MM-DD-YYYY"   timeStr: "8:30am" | "12:00pm" | ""
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
    // ForexFactory times are US Eastern
    // EDT (UTC-4): March-November  |  EST (UTC-5): November-March
    const isDST     = month >= 3 && month <= 11;
    const offsetHrs = isDST ? 4 : 5;
    const localMs   = Date.UTC(year, month - 1, day, hours, minutes, 0);
    return localMs + offsetHrs * 60 * 60 * 1000;
}

function extractEvents(parsed) {
    if (!parsed) return [];

    // FF XML structure: <weeklyevents><event>...</event></weeklyevents>
    // field is <country> not <currency>
    // impact values: "High", "Medium", "Low", "Holiday"
    const items = parsed?.weeklyevents?.event;
    if (!items) {
        console.warn("  WARNING: could not find weeklyevents.event in parsed XML");
        console.log("  top-level keys:", Object.keys(parsed));
        return [];
    }

    const arr   = Array.isArray(items) ? items : [items];
    console.log(`  total events in feed: ${arr.length}`);

    const now   = Date.now();
    const in14d = now + 14 * 24 * 60 * 60 * 1000;
    const found = [];

    for (const item of arr) {
        // FF uses <country> for the currency code
        if (item?.country !== "USD")  continue;
        if (item?.impact  !== "High") continue;
        if (!item?.date)              continue;

        const utcMs = toUtcMs(item.date, item.time || "");
        if (utcMs < now - 60 * 60 * 1000) continue; // skip >1h past
        if (utcMs > in14d)               continue; // skip beyond 14 days

        found.push({
            title:     item.title || "Unknown",
            timestamp: Math.floor(utcMs / 1000),
            date:      new Date(utcMs).toISOString(),
        });
    }

    return found;
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

    // This week
    const thisWeekText = await fetchRaw(FF_THIS_WEEK);
    if (thisWeekText) {
        try {
            const parsed = await xml2js.parseStringPromise(thisWeekText, { explicitArray: false });
            const events = extractEvents(parsed);
            console.log(`  matched ${events.length} high-impact USD events this week`);
            allEvents = allEvents.concat(events);
        } catch (err) {
            console.warn(`  parse error this week: ${err.message}`);
        }
    }

    // Next week — FF serves this at a date-based URL when the weekly one 404s
    // Try the weekly URL first, then fall back to a date-computed URL
    const now         = new Date();
    const dayOfWeek   = now.getUTCDay(); // 0=Sun, 1=Mon ... 6=Sat
    const daysToNext  = (7 - dayOfWeek + 1) % 7 || 7; // days until next Monday
    const nextMonday  = new Date(now);
    nextMonday.setUTCDate(now.getUTCDate() + daysToNext);
    const yyyy = nextMonday.getUTCFullYear();
    const mm   = String(nextMonday.getUTCMonth() + 1).padStart(2, "0");
    const dd   = String(nextMonday.getUTCDate()).padStart(2, "0");
    const nextWeekUrl = `https://nfs.faireconomy.media/ff_calendar_week_${yyyy}${mm}${dd}.xml`;
    console.log(`  trying next week URL: ${nextWeekUrl}`);

    const nextWeekText = await fetchRaw(nextWeekUrl);
    if (nextWeekText) {
        try {
            const parsed = await xml2js.parseStringPromise(nextWeekText, { explicitArray: false });
            const events = extractEvents(parsed);
            console.log(`  matched ${events.length} high-impact USD events next week`);
            allEvents = allEvents.concat(events);
        } catch (err) {
            console.warn(`  parse error next week: ${err.message}`);
        }
    }

    if (allEvents.length === 0) {
        console.warn("[fetch_events] no matching events found — writing blank CSV");
        writeCSV([]);
        console.log("[fetch_events] done (blank).");
        return;
    }

    // Deduplicate by timestamp, sort ascending, cap at 12
    const seen   = new Set();
    const unique = allEvents
        .filter(e => {
            if (seen.has(e.timestamp)) return false;
            seen.add(e.timestamp);
            return true;
        })
        .sort((a, b) => a.timestamp - b.timestamp)
        .slice(0, MAX_EVENTS);

    console.log(`[fetch_events] writing ${unique.length} events:`);
    unique.forEach(e => console.log(`  ${e.date}  ${e.title}  (${e.timestamp})`));

    writeCSV(unique);
    console.log("[fetch_events] done.");
}

main().catch(err => {
    console.error("[fetch_events] FATAL:", err);
    process.exit(1);
});

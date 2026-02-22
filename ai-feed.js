const { Client } = require('@notionhq/client');
const Parser = require('rss-parser');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const axios = require('axios');
const { JSDOM } = require('jsdom');
const https = require('https');
const { execSync } = require('child_process');
const he = require('he');

// Init Clients
const notion = new Client({ auth: process.env.NOTION_API_TOKEN });

const parser = new Parser({
    requestOptions: {
        rejectUnauthorized: false // Fix for Stockbiz certificate error
    }
});

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const FEEDS_DB_ID = process.env.NOTION_FEEDS_DATABASE_ID;
const READER_DB_ID = process.env.NOTION_READER_DATABASE_ID;

// --- SETTINGS ---
const MODEL_NAME = "gemini-2.5-flash";

// SECURITY FIX: Create an agent that ignores "certificate has expired" errors
const httpsAgent = new https.Agent({ rejectUnauthorized: false });

// Rate limiter + retry with backoff for Notion API calls
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const NOTION_DELAY_MS = 400;

async function notionRetry(fn, label = 'Notion call', maxRetries = 3) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        await delay(NOTION_DELAY_MS);
        try {
            return await fn();
        } catch (e) {
            if (e.code === 'rate_limited' && attempt < maxRetries) {
                const waitMs = 15000 * Math.pow(2, attempt - 1); // 15s, 30s, 60s
                console.warn(`Rate limited on ${label}. Waiting ${waitMs / 1000}s before retry ${attempt + 1}/${maxRetries}...`);
                await delay(waitMs);
            } else {
                throw e;
            }
        }
    }
}

// Helper: Ensure URL has a protocol
function normalizeUrl(url) {
    if (url && !url.startsWith('http://') && !url.startsWith('https://')) {
        return 'https://' + url;
    }
    return url;
}

// Helper to clean XML (remove BOM, leading whitespace)
function cleanXml(xml) {
    if (!xml) return "";
    return xml.trim().replace(/^\uFEFF/, '');
}

// Helper: Case-insensitive check if data looks like HTML
function looksLikeHtml(data) {
    const trimmed = data.trim().substring(0, 500).toLowerCase();
    return trimmed.startsWith("<!doctype html") || trimmed.includes("<html") || trimmed.includes("<title>error");
}

// Helper: Use Gemini to generate a synthetic RSS feed from an HTML page
async function generateFeedFromUrl(url, html) {
    console.log(`Generating synthetic feed for: ${url}`);

    // Clean HTML to reduce tokens: strip script, style, and keep text structure
    const dom = new JSDOM(html);
    const doc = dom.window.document;

    // Remove noise elements
    doc.querySelectorAll('script, style, nav, footer, header, iframe, noscript, svg').forEach(el => el.remove());

    const cleanedHtml = doc.body ? doc.body.innerHTML.substring(0, 30000) : html.substring(0, 30000);

    const prompt = `You are an HTML parser. Analyze this webpage and extract the latest articles/posts/news items.

Return ONLY a valid JSON array (no markdown, no code fences) with up to 10 items. Each item must have:
- "title": the article headline
- "link": the FULL absolute URL to the article (resolve relative URLs using base: ${url})
- "date": publication date in ISO 8601 format if available, otherwise empty string
- "snippet": a 1-2 sentence preview if available, otherwise empty string

If you cannot find any articles, return an empty array: []

HTML content:
${cleanedHtml}`;

    const model = genAI.getGenerativeModel({ model: MODEL_NAME });
    const result = await model.generateContent(prompt);
    const responseText = result.response.text().trim();

    // Parse JSON from response (strip markdown code fences if present)
    let jsonStr = responseText;
    if (jsonStr.startsWith('```')) {
        jsonStr = jsonStr.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    }

    let articles;
    try {
        articles = JSON.parse(jsonStr);
    } catch (e) {
        console.error(`Failed to parse AI response as JSON: ${e.message}`);
        console.error(`Response: ${responseText.substring(0, 200)}...`);
        throw new Error("AI feed generation returned invalid JSON");
    }

    if (!Array.isArray(articles) || articles.length === 0) {
        throw new Error("AI found no articles on the page");
    }

    console.log(`AI extracted ${articles.length} articles from HTML`);

    // Convert to RSS 2.0 XML
    const escapeXml = (str) => str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');

    const itemsXml = articles.map(a => `
    <item>
      <title>${escapeXml(a.title || 'Untitled')}</title>
      <link>${escapeXml(a.link || '')}</link>
      ${a.date ? `<pubDate>${new Date(a.date).toUTCString()}</pubDate>` : ''}
      ${a.snippet ? `<description>${escapeXml(a.snippet)}</description>` : ''}
    </item>`).join('\n');

    return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>AI-Generated Feed: ${escapeXml(url)}</title>
    <link>${escapeXml(url)}</link>
    <description>Synthetic feed generated by AI from ${escapeXml(url)}</description>
    ${itemsXml}
  </channel>
</rss>`;
}

// Helper to fetch feed with fallback (+ AI generation for non-RSS sites)
async function fetchFeed(url) {
    let lastHtml = null;

    try {
        // 1. Try Axios (Standard Browser)
        const response = await axios.get(url, {
            timeout: 10000,
            httpsAgent: httpsAgent,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'application/rss+xml, application/xml, text/xml, text/html; q=0.1'
            }
        });

        const data = typeof response.data === 'string' ? response.data : JSON.stringify(response.data);

        // HTML CHECK: If we got HTML, save it for AI generation fallback
        if (looksLikeHtml(data)) {
            lastHtml = data;
            throw new Error("Axios returned HTML (not a feed)");
        }

        return cleanXml(data);
    } catch (axiosError) {
        console.warn(`Axios fetch failed for ${url}: ${axiosError.message}. Trying curl...`);

        try {
            // 2. Try Curl with Bingbot UA
            const curlCmdBot = `curl -L -k -sS -A "Mozilla/5.0 (compatible; Bingbot/2.0; +http://www.bing.com/bingbot.htm)" "${url}"`;
            const stdoutBot = execSync(curlCmdBot, { timeout: 15000, encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 });

            if (!stdoutBot || stdoutBot.length < 50) throw new Error("Curl (Bingbot) returned empty/short response");

            // Check for HTML
            if (looksLikeHtml(stdoutBot)) {
                lastHtml = stdoutBot; // Save for AI fallback
                throw new Error("Curl returned HTML (not a feed)");
            }

            return cleanXml(stdoutBot);
        } catch (curlError) {
            // 3. FINAL FALLBACK: AI Feed Generation
            if (lastHtml) {
                console.log(`Standard fetch methods failed. Attempting AI feed generation for ${url}...`);
                return await generateFeedFromUrl(url, lastHtml);
            }

            // If we never got HTML either, try fetching the page directly for AI
            try {
                console.log(`Fetching page for AI feed generation: ${url}`);
                const pageResponse = await axios.get(url, {
                    timeout: 10000,
                    httpsAgent: httpsAgent,
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
                    }
                });
                return await generateFeedFromUrl(url, typeof pageResponse.data === 'string' ? pageResponse.data : JSON.stringify(pageResponse.data));
            } catch (finalError) {
                throw new Error(`All fetch methods failed. Last error: ${finalError.message}`);
            }
        }
    }
}

// Pre-fetch all existing links from Notion to avoid per-item dedup API calls
async function loadExistingLinks() {
    const existingLinks = new Set();
    let hasMore = true;
    let startCursor = undefined;
    let pageCount = 0;

    console.log('Loading existing links from Notion for dedup...');

    while (hasMore) {
        const response = await notionRetry(() => notion.databases.query({
            database_id: READER_DB_ID,
            start_cursor: startCursor,
            page_size: 100
        }), 'loadExistingLinks');

        for (const page of response.results) {
            const link = page.properties.Link?.url;
            if (link) existingLinks.add(link);
        }

        pageCount += response.results.length;
        hasMore = response.has_more;
        startCursor = response.next_cursor;
    }

    console.log(`Loaded ${existingLinks.size} existing links (${pageCount} pages).`);
    return existingLinks;
}

async function main() {
    console.log("Script Version: FEED COLLECTOR v3.3 (In-Memory Dedup, AI Feed Generation)");

    try {
        // STEP 1: Load feeds and existing links
        console.log('Fetching feeds from Notion...');
        const response = await notionRetry(() => notion.databases.query({ database_id: FEEDS_DB_ID }), 'fetchFeeds');
        const feedUrls = response.results.map(p => p.properties.Link?.url || p.properties.URL?.url).filter(u => u);
        console.log(`Found ${feedUrls.length} feeds.`);

        // STEP 2: Pre-load ALL existing article links into memory (eliminates ~50% of API calls)
        const existingLinks = await loadExistingLinks();

        let newArticles = 0;
        const failedFeeds = [];

        for (let url of feedUrls) {
            url = normalizeUrl(url);
            try {
                // ROBUST FETCH: Fetch string -> Clean -> Parse
                const feedData = await fetchFeed(url);
                let feed;

                try {
                    feed = await parser.parseString(feedData);
                } catch (parseError) {
                    const snippet = feedData.substring(0, 200).replace(/\n/g, " ");
                    console.error(`Parse Error for ${url}: ${parseError.message}`);
                    console.error(`Snippet: ${snippet}...`);
                    throw parseError;
                }

                if (!feed || !feed.items || feed.items.length === 0) continue;

                // PROCESS TOP 10 ITEMS
                const itemsToProcess = feed.items.slice(0, 10);

                for (const item of itemsToProcess) {
                    if (!item.link) continue;

                    // DECODE TITLE
                    if (item.title) {
                        let decoded = item.title;

                        const decodeNumeric = (str) => {
                            return str.replace(/&#(\d+);/g, (match, dec) => String.fromCharCode(dec))
                                .replace(/&#x([0-9a-f]+);/gi, (match, hex) => String.fromCharCode(parseInt(hex, 16)));
                        };

                        try {
                            let output = he.decode(decoded);
                            let i = 0;
                            while (output !== decoded && i < 5) {
                                decoded = output;
                                output = he.decode(decoded);
                                i++;
                            }
                        } catch (e) { console.warn("he.decode failed:", e); }

                        decoded = decodeNumeric(decoded);
                        try { decoded = he.decode(decoded); } catch (e) { }

                        item.title = decoded;
                    }

                    // TIME FILTER
                    if (process.env.RUN_FREQUENCY) {
                        const pubDate = new Date(item.isoDate || item.pubDate);
                        const timeDiff = (new Date() - pubDate) / 1000;
                        if (timeDiff > parseInt(process.env.RUN_FREQUENCY)) {
                            if (itemsToProcess.indexOf(item) === 0) {
                                console.log(`Skipping old item: ${item.title} (${Math.round(timeDiff / 60)} mins old)`);
                            }
                            continue;
                        }
                    }

                    // 1. FAST DEDUP: Check in-memory Set (NO API call!)
                    if (existingLinks.has(item.link)) {
                        continue; // Silent skip — no log spam for existing items
                    }

                    console.log(`New: ${item.title}`);

                    // 2. Create Notion page (Title + Link only)
                    await notionRetry(() => notion.pages.create({
                        parent: { database_id: READER_DB_ID },
                        properties: {
                            "Title": { title: [{ type: "text", text: { content: item.title || "Untitled" } }] },
                            "Link": { url: item.link }
                        }
                    }), `create: ${item.title}`);
                    console.log(`Logged: ${item.title}`);
                    newArticles++;

                    // Track locally so we don't create duplicates within the same run
                    existingLinks.add(item.link);
                }

            } catch (e) {
                console.error(`Failed to process feed ${url}: ${e.message}`);
                failedFeeds.push({ url: url, error: e.message });
            }
        }

        // Summary Log
        console.log(`\nDone. Logged ${newArticles} new articles. Failed feeds: ${failedFeeds.length}`);
        if (failedFeeds.length > 0) {
            console.log("Failed feeds:");
            failedFeeds.forEach(f => console.log(`  - ${f.url}: ${f.error}`));
        }
    } catch (e) { console.error('Critical Main Error:', e.message); }
}

main();

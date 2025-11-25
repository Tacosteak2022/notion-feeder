const { Client } = require('@notionhq/client');
const Parser = require('rss-parser');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const axios = require('axios');
const { JSDOM, VirtualConsole } = require('jsdom');
const { Readability } = require('@mozilla/readability');
const https = require('https');

// Init Clients
const notion = new Client({ auth: process.env.NOTION_API_TOKEN });
const parser = new Parser();
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const FEEDS_DB_ID = process.env.NOTION_FEEDS_DATABASE_ID;
const READER_DB_ID = process.env.NOTION_READER_DATABASE_ID;

// --- SETTINGS ---
// We use the specific version '001' to fix the 404 error
const MODEL_NAME = "gemini-2.5-flash";

const SYSTEM_PROMPT = `
You are an experienced investment analyst. Summarize this article for your portfolio manager. 

Format strictly: using 3-4 sentences only. 

Extract stock prices, percentages, or figures if any and explain why it matters and the impact on the market.
`;

// SECURITY FIX: Create an agent that ignores "certificate has expired" errors
const httpsAgent = new https.Agent({ rejectUnauthorized: false });

// CSS FIX: Ignore stylesheet errors
const virtualConsole = new VirtualConsole();
virtualConsole.on("error", () => { /* Ignore CSS errors */ });

async function main() {
    console.log("Script Version: FINAL FIXED (Security + Model Update)"); // Look for this in logs!

    try {
        console.log('Fetching feeds from Notion...');
        const response = await notion.databases.query({ database_id: FEEDS_DB_ID });
        const feedUrls = response.results.map(p => p.properties.Link?.url || p.properties.URL?.url).filter(u => u);

        console.log(`Found ${feedUrls.length} feeds.`);

        for (const url of feedUrls) {
            let item = null;

            try {
                const feed = await parser.parseURL(url);
                item = feed.items[0];

                if (!item || !item.link) continue;

                ```javascript
const { Client } = require('@notionhq/client');
const Parser = require('rss-parser');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const axios = require('axios');
const { JSDOM, VirtualConsole } = require('jsdom');
const { Readability } = require('@mozilla/readability');
const https = require('https');

// Init Clients
const notion = new Client({ auth: process.env.NOTION_API_TOKEN });
const parser = new Parser();
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const FEEDS_DB_ID = process.env.NOTION_FEEDS_DATABASE_ID;
const READER_DB_ID = process.env.NOTION_READER_DATABASE_ID;

// --- SETTINGS ---
// We use the specific version '001' to fix the 404 error
const MODEL_NAME = "gemini-2.5-flash";

const SYSTEM_PROMPT = `
You are a financial analyst.Summarize this article for an investor.
Format strictly:
- ** TL; DR **: One sentence summary.
- ** Key Data **: Extract stock prices, percentages, or figures.
- ** Why it matters **: Impact on the market.
`;

// SECURITY FIX: Create an agent that ignores "certificate has expired" errors
const httpsAgent = new https.Agent({ rejectUnauthorized: false });

// CSS FIX: Ignore stylesheet errors
const virtualConsole = new VirtualConsole();
virtualConsole.on("error", () => { /* Ignore CSS errors */ });

async function main() {
    console.log("Script Version: FINAL FIXED (Security + Model Update)"); // Look for this in logs!

    try {
        console.log('Fetching feeds from Notion...');
        const response = await notion.databases.query({ database_id: FEEDS_DB_ID });
        const feedUrls = response.results.map(p => p.properties.Link?.url || p.properties.URL?.url).filter(u => u);

        console.log(`Found ${ feedUrls.length } feeds.`);

        for (const url of feedUrls) {
            let item = null;

            try {
                const feed = await parser.parseURL(url);
                item = feed.items[0];

                if (!item || !item.link) continue;

                // TIME FILTER: Skip items older than RUN_FREQUENCY (in seconds)
                if (process.env.RUN_FREQUENCY) {
                    const pubDate = new Date(item.isoDate || item.pubDate);
                    const timeDiff = (new Date() - pubDate) / 1000; // in seconds
                    if (timeDiff > parseInt(process.env.RUN_FREQUENCY)) {
                        console.log(`Skipping old item: ${ item.title } (${ Math.round(timeDiff / 60) } mins old)`);
                        continue;
                    }
                }

                console.log(`Checking: ${ item.title } `);

                // 1. Check Duplicates & Backfill Status
                let pageToUpdate = null;
                const existing = await notion.databases.query({
                    database_id: READER_DB_ID,
                    filter: { property: 'Link', url: { equals: item.link } }
                });

                if (existing.results.length > 0) {
                    const page = existing.results[0];
                    const currentSummary = page.properties["AI Summary"]?.rich_text;
                    
                    // If summary exists and is not empty, skip
                    if (currentSummary && currentSummary.length > 0) {
                        console.log('Skipping existing (Summary present).');
                        continue;
                    } else {
                        console.log('Existing found but Summary missing. Backfilling...');
                        pageToUpdate = page.id;
                    }
                }

                // 2. Scrape
                const { data } = await axios.get(item.link, { 
                    timeout: 15000,
                    httpsAgent: httpsAgent, // Applies the security fix
                    headers: { 
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' 
                    } 
                });

                const doc = new JSDOM(data, { url: item.link, virtualConsole });
                const article = new Readability(doc.window.document).parse();
                
                const textToRead = article ? article.textContent.substring(0, 15000) : (item.contentSnippet || "");

                // 3. Summarize
                console.log(`Generating AI summary using ${ MODEL_NAME }...`);
                const model = genAI.getGenerativeModel({ 
                    model: MODEL_NAME, 
                    systemInstruction: SYSTEM_PROMPT 
                });
                
                const result = await model.generateContent(textToRead);
                const summary = result.response.text();
                const safeSummary = summary.substring(0, 2000);

                // 4. Post or Update Notion
                if (pageToUpdate) {
                    await notion.pages.update({
                        page_id: pageToUpdate,
                        properties: {
                            "AI Summary": { rich_text: [{ type: "text", text: { content: safeSummary } }] }
                        }
                    });
                    console.log(`Updated(Backfilled): ${ item.title } `);
                } else {
                    await notion.pages.create({
                        parent: { database_id: READER_DB_ID },
                        properties: {
                            "Title": { title: [{ type: "text", text: { content: item.title } }] },
                            "Link": { url: item.link },
                            "AI Summary": { rich_text: [{ type: "text", text: { content: safeSummary } }] }
                        }
                    });
                    console.log(`Saved: ${ item.title } `);
                }

            } catch (e) {
                const title = item ? item.title : "Unknown";
                console.error(`Failed to process "${title}": ${ e.message } `);
            }
        }
    } catch (e) { console.error('Critical Main Error:', e.message); }
}

main();
```

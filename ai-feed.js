const { Client } = require('@notionhq/client');
const Parser = require('rss-parser');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const axios = require('axios');
const { JSDOM, VirtualConsole } = require('jsdom');
const { Readability } = require('@mozilla/readability');
const https = require('https');
const { execSync } = require('child_process');

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

// Helper to fetch feed with fallback
async function fetchFeed(url) {
    try {
        // 1. Try Axios
        const response = await axios.get(url, {
            timeout: 10000,
            httpsAgent: httpsAgent,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'application/rss+xml, application/xml, text/xml; q=0.1'
            }
        });
        return response.data;
    } catch (axiosError) {
        console.warn(`Axios fetch failed for ${url}: ${axiosError.message}. Trying curl...`);
        try {
            // 2. Try Curl (often bypasses 403/TLS issues in CI)
            // -L follows redirects, -k ignores SSL errors, -sS silences progress but shows errors
            // Added more headers to mimic a real browser
            const curlCmd = `curl -L -k -sS -A "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36" -H "Accept: application/rss+xml, application/xml, text/xml; q=0.1" "${url}"`;
            const stdout = execSync(curlCmd, { timeout: 15000, encoding: 'utf-8' });

            if (!stdout || stdout.length < 50) throw new Error("Curl returned empty/short response");

            // Check if we got HTML instead of XML (CAPTCHA or Block Page)
            if (stdout.trim().startsWith("<!DOCTYPE html") || stdout.includes("Just a moment...")) {
                throw new Error("Curl returned HTML (likely CAPTCHA/Block page) instead of RSS XML");
            }

            return stdout;
        } catch (curlError) {
            throw new Error(`All fetch methods failed. Axios: ${axiosError.message}, Curl: ${curlError.message}`);
        }
    }
}

async function main() {
    console.log("Script Version: DIGEST + FAILED FEEDS + SUBSTACK FIX + SKIP AI + CURL FALLBACK");

    try {
        console.log('Fetching feeds from Notion...');
        const response = await notion.databases.query({ database_id: FEEDS_DB_ID });
        const feedUrls = response.results.map(p => p.properties.Link?.url || p.properties.URL?.url).filter(u => u);

        console.log(`Found ${feedUrls.length} feeds.`);

        const newArticles = [];
        const failedFeeds = [];

        for (const url of feedUrls) {
            let item = null;

            try {
                // FETCH FIX: Use robust fetchFeed helper
                const feedData = await fetchFeed(url);
                const feed = await parser.parseString(feedData);
                item = feed.items[0];

                if (!item || !item.link) continue;

                // TIME FILTER: Skip items older than RUN_FREQUENCY (in seconds)
                if (process.env.RUN_FREQUENCY) {
                    const pubDate = new Date(item.isoDate || item.pubDate);
                    const timeDiff = (new Date() - pubDate) / 1000; // in seconds
                    if (timeDiff > parseInt(process.env.RUN_FREQUENCY)) {
                        console.log(`Skipping old item: ${item.title} (${Math.round(timeDiff / 60)} mins old)`);
                        continue;
                    }
                }

                console.log(`Checking: ${item.title}`);

                // 1. Check Duplicates (Log Page Check)
                const existing = await notion.databases.query({
                    database_id: READER_DB_ID,
                    filter: { property: 'Link', url: { equals: item.link } }
                });

                if (existing.results.length > 0) {
                    console.log('Skipping existing.');
                    continue;
                }

                // 2. Check if we should skip AI Summary
                const SKIP_DOMAINS = ["substack.com", "f319.com", "cafef.vn/du-lieu/report/"];
                const shouldSkipAI = SKIP_DOMAINS.some(domain => item.link.includes(domain));

                let safeSummary = "";

                if (shouldSkipAI) {
                    console.log(`Skipping AI Summary for: ${item.link}`);
                    safeSummary = "Direct Link (Summary Skipped)";
                } else {
                    // 3. Scrape (with Fallback)
                    let textToRead = "";
                    try {
                        console.log(`Scraping: ${item.link}`);
                        const { data } = await axios.get(item.link, {
                            timeout: 10000, // Reduced timeout for faster fallback
                            httpsAgent: httpsAgent,
                            headers: {
                                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
                            }
                        });

                        const doc = new JSDOM(data, { url: item.link, virtualConsole });
                        const article = new Readability(doc.window.document).parse();

                        if (article && article.textContent.length > 500) {
                            textToRead = article.textContent.substring(0, 15000);
                        } else {
                            throw new Error("Scraped content too short or empty.");
                        }
                    } catch (scrapeError) {
                        console.warn(`Scraping failed for ${item.link}: ${scrapeError.message}. Using RSS content fallback.`);

                        // Fallback to RSS content
                        const fallbackContent = item.content || item.contentSnippet || "";

                        // Strip HTML if using item.content
                        if (fallbackContent.includes("<")) {
                            const dom = new JSDOM(fallbackContent);
                            textToRead = dom.window.document.body.textContent || "";
                        } else {
                            textToRead = fallbackContent;
                        }

                        if (textToRead.length < 100) {
                            // If still too short, track as failure
                            throw new Error(`Content too short even after fallback (${textToRead.length} chars).`);
                        }
                    }

                    // 4. Summarize
                    console.log(`Generating AI summary using ${MODEL_NAME}...`);
                    const model = genAI.getGenerativeModel({
                        model: MODEL_NAME,
                        systemInstruction: SYSTEM_PROMPT
                    });

                    const result = await model.generateContent(textToRead);
                    const summary = result.response.text();
                    safeSummary = summary.substring(0, 2000);
                }

                // 5. Log It / Create Page
                // If it's a "Skip AI" domain, we create a visible page and DON'T add to digest
                if (shouldSkipAI) {
                    await notion.pages.create({
                        parent: { database_id: READER_DB_ID },
                        properties: {
                            "Title": { title: [{ type: "text", text: { content: item.title } }] },
                            "Link": { url: item.link },
                            "AI Summary": { rich_text: [{ type: "text", text: { content: "Direct Link (No AI Summary)" } }] }
                        }
                    });
                    console.log(`Created Individual Page: ${item.title}`);
                    continue; // SKIP adding to Digest
                }

                // For normal articles, we create a "Log Entry" (to track duplicates) and add to Digest
                await notion.pages.create({
                    parent: { database_id: READER_DB_ID },
                    properties: {
                        "Title": { title: [{ type: "text", text: { content: item.title } }] },
                        "Link": { url: item.link },
                        "AI Summary": { rich_text: [{ type: "text", text: { content: "Log Entry - Included in Digest" } }] }
                    }
                });
                console.log(`Logged: ${item.title}`);

                // 6. Add to Digest List
                newArticles.push({
                    title: item.title,
                    link: item.link,
                    summary: safeSummary
                });

            } catch (e) {
                const title = item ? item.title : "Unknown";
                console.error(`Failed to process "${title}": ${e.message}`);

                // Track failed feed if it was a feed error (url is the feed url)
                if (!item) {
                    failedFeeds.push({ url: url, error: e.message });
                }
            }
        }

        // 7. Create Digest Page
        if (newArticles.length > 0 || failedFeeds.length > 0) {
            console.log(`Creating Market Summary with ${newArticles.length} articles and ${failedFeeds.length} failures...`);

            // Notion blocks (max 100 per request, simple split if needed, but assuming <100 for now)
            const blocks = [];

            // A. Add Articles
            for (const article of newArticles) {
                blocks.push({
                    object: 'block',
                    type: 'heading_2',
                    heading_2: {
                        rich_text: [{ type: 'text', text: { content: article.title }, annotations: { bold: true } }]
                    }
                });
                blocks.push({
                    object: 'block',
                    type: 'paragraph',
                    paragraph: {
                        rich_text: [
                            { type: 'text', text: { content: "Source: " } },
                            { type: 'text', text: { content: "Link", link: { url: article.link } } }
                        ]
                    }
                });
                blocks.push({
                    object: 'block',
                    type: 'paragraph',
                    paragraph: {
                        rich_text: [{ type: 'text', text: { content: article.summary } }]
                    }
                });
                blocks.push({ object: 'block', type: 'divider', divider: {} });
            }

            // B. Add Failed Feeds Section (if any)
            if (failedFeeds.length > 0) {
                blocks.push({
                    object: 'block',
                    type: 'heading_2',
                    heading_2: {
                        rich_text: [{ type: 'text', text: { content: "⚠️ Failed Feeds" }, annotations: { color: "red" } }]
                    }
                });
                for (const fail of failedFeeds) {
                    blocks.push({
                        object: 'block',
                        type: 'paragraph',
                        paragraph: {
                            rich_text: [
                                { type: 'text', text: { content: `Feed: ${fail.url}\nError: ${fail.error}` } }
                            ]
                        }
                    });
                }
            }

            // Create the Digest Page
            const now = new Date().toLocaleString('en-US', { timeZone: 'Asia/Ho_Chi_Minh' });
            await notion.pages.create({
                parent: { database_id: READER_DB_ID },
                properties: {
                    "Title": { title: [{ type: "text", text: { content: `Market Summary @ ${now}` } }] },
                    "AI Summary": { rich_text: [{ type: "text", text: { content: `Contains ${newArticles.length} articles. Failed: ${failedFeeds.length}` } }] }
                },
                children: blocks.slice(0, 100) // Notion limit: 100 blocks
            });
            console.log("Market Summary Created Successfully!");
        } else {
            console.log("No new articles to summarize.");
        }
    } catch (e) { console.error('Critical Main Error:', e.message); }
}

main();

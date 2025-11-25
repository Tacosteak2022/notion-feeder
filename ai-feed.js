const { Client } = require('@notionhq/client');
const Parser = require('rss-parser');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const axios = require('axios');
const { JSDOM } = require('jsdom');
const { Readability } = require('@mozilla/readability');

const notion = new Client({ auth: process.env.NOTION_API_TOKEN });
const parser = new Parser();
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const FEEDS_DB_ID = process.env.NOTION_FEEDS_DATABASE_ID;
const READER_DB_ID = process.env.NOTION_READER_DATABASE_ID;

// --- YOUR CUSTOM PROMPT ---
const SYSTEM_PROMPT = `
You are a financial analyst assistant. 
Read the article and summarize it for a busy investor.
Format strictly:
- **TL;DR**: One sentence summary.
- **Key Data**: Extract any stock prices, percentages, or money figures.
- **Why it matters**: How this impacts the market.
`;
// --------------------------

async function main() {
  try {
    console.log('Fetching feeds from Notion...');
    const response = await notion.databases.query({ database_id: FEEDS_DB_ID });
    const feedUrls = response.results.map(page => {
        return page.properties.Link?.url || page.properties.URL?.url;
    }).filter(url => url);

    console.log(`Found ${feedUrls.length} feeds.`);

    for (const url of feedUrls) {
      try {
        const feed = await parser.parseURL(url);
        const item = feed.items[0]; // Latest item only
        if (!item) continue;

        console.log(`Checking: ${item.title}`);

        // 1. DUPLICATE CHECK
        const existing = await notion.databases.query({
            database_id: READER_DB_ID,
            filter: { property: 'Link', url: { equals: item.link } }
        });
        if (existing.results.length > 0) { 
            console.log('Skipping existing.'); 
            continue; 
        }

        // 2. SCRAPE
        const { data } = await axios.get(item.link, { timeout: 10000 });
        const doc = new JSDOM(data, { url: item.link });
        const article = new Readability(doc.window.document).parse();
        const textToRead = article ? article.textContent.substring(0, 20000) : item.contentSnippet;

        // 3. AI SUMMARIZE
        const model = genAI.getGenerativeModel({ 
            model: "gemini-1.5-flash", 
            systemInstruction: SYSTEM_PROMPT 
        });
        const result = await model.generateContent(textToRead);
        const summary = result.response.text();

        // 4. POST TO NOTION (Property: "AI summary")
        const safeSummary = summary.substring(0, 2000); // Notion limit

        await notion.pages.create({
            parent: { database_id: READER_DB_ID },
            properties: {
                Name: { title: [{ text: { content: item.title } }] },
                Link: { url: item.link },
                "AI summary": { 
                    rich_text: [{ text: { content: safeSummary } }] 
                }
            }
        });
        console.log(`Saved: ${item.title}`);

      } catch (e) { console.error(`Feed Error (${url}):`, e.message); }
    }
  } catch (e) { console.error('Main Error:', e.message); }
}
main();

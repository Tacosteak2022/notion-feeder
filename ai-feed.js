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

const SYSTEM_PROMPT = `
You are a financial analyst. Summarize this article for an investor.
Format strictly:
- **TL;DR**: One sentence summary.
- **Key Data**: Extract stock prices, percentages, or figures.
- **Why it matters**: Impact on the market.
`;

async function main() {
  try {
    console.log('Fetching feeds from Notion...');
    const response = await notion.databases.query({ database_id: FEEDS_DB_ID });
    const feedUrls = response.results.map(p => p.properties.Link?.url || p.properties.URL?.url).filter(u => u);
    
    console.log(`Found ${feedUrls.length} feeds.`);
    
    for (const url of feedUrls) {
      try {
        const feed = await parser.parseURL(url);
        const item = feed.items[0]; 
        if (!item) continue;

        console.log(`Checking: ${item.title}`);
        
        // 1. Check Duplicates
        const existing = await notion.databases.query({
            database_id: READER_DB_ID,
            filter: { property: 'Link', url: { equals: item.link } }
        });
        if (existing.results.length > 0) { console.log('Skipping existing.'); continue; }

        // 2. Scrape
        const { data } = await axios.get(item.link, { timeout: 10000 });
        const doc = new JSDOM(data, { url: item.link });
        const article = new Readability(doc.window.document).parse();
        const textToRead = article ? article.textContent.substring(0, 20000) : item.contentSnippet;

        // 3. Summarize
        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash", systemInstruction: SYSTEM_PROMPT });
        const result = await model.generateContent(textToRead);
        const summary = result.response.text();
        const safeSummary = summary.substring(0, 2000);

        // 4. Post to Notion
        await notion.pages.create({
            parent: { database_id: READER_DB_ID },
            properties: {
                "Name": { 
                    title: [{ type: "text", text: { content: item.title } }] 
                },
                "Link": { 
                    url: item.link 
                },
                // FIXED: Capital "S" to match your Notion Database
                "AI Summary": { 
                    rich_text: [
                        { type: "text", text: { content: safeSummary } }
                    ]
                }
            }
        });
        console.log(`Saved: ${item.title}`);

      } catch (e) {
        console.error(`Failed to save "${item.title}":`, e.body || e.message);
      }
    }
  } catch (e) { console.error('Main Error:', e.message); }
}

main();

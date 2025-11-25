const { Client } = require('@notionhq/client');
const Parser = require('rss-parser');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const axios = require('axios');
const { JSDOM } = require('jsdom');
const { Readability } = require('@mozilla/readability');

// Initialize clients
const notion = new Client({ auth: process.env.NOTION_API_TOKEN });
const parser = new Parser();
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Configuration
const FEEDS_DB_ID = process.env.NOTION_FEEDS_DATABASE_ID;
const READER_DB_ID = process.env.NOTION_READER_DATABASE_ID;

// SYSTEM INSTRUCTION (How you want the summary to look)
const SYSTEM_PROMPT = `
You are a helpful research assistant. Read the provided article text and summarize it.
Format the output strictly as follows:
- **TL;DR**: A one-sentence summary.
- **Key Points**: Bullet points of the most important details.
- **Why it matters**: Why this news is significant.
`;

async function getFeedUrls() {
  const response = await notion.databases.query({
    database_id: FEEDS_DB_ID,
  });
  return response.results.map(page => {
    return page.properties.Link?.url || page.properties.URL?.url; 
  }).filter(url => url);
}

async function extractArticleContent(url) {
  try {
    const { data } = await axios.get(url, { timeout: 10000 });
    const doc = new JSDOM(data, { url });
    const reader = new Readability(doc.window.document);
    const article = reader.parse();
    return article ? article.textContent : null;
  } catch (error) {
    console.error(`Failed to scrape ${url}:`, error.message);
    return null;
  }
}

async function generateSummary(text) {
  if (!text) return "Could not extract text from article.";

  // Gemini 1.5 Flash handles large context, but we limit reasonably
  const truncatedText = text.substring(0, 30000);

  try {
    // Use 'gemini-1.5-flash' for speed and efficiency
    const model = genAI.getGenerativeModel({ 
        model: "gemini-1.5-flash",
        systemInstruction: SYSTEM_PROMPT 
    });

    const result = await model.generateContent(truncatedText);
    const response = await result.response;
    return response.text();
  } catch (error) {
    console.error("Gemini API Error:", error.message);
    return "AI generation failed.";
  }
}

async function postToNotion(title, url, summary, feedName) {
    // Check if link exists (Deduplication)
    const existing = await notion.databases.query({
        database_id: READER_DB_ID,
        filter: { property: 'Link', url: { equals: url } }
    });
    
    if (existing.results.length > 0) {
        console.log(`Skipping existing: ${title}`);
        return;
    }

    // Create Notion Page
    await notion.pages.create({
        parent: { database_id: READER_DB_ID },
        properties: {
            Name: { title: [{ text: { content: title } }] },
            Link: { url: url },
            // Optional: Add feed source tag if you have a 'Select' property named 'Source'
            // Source: { select: { name: feedName } } 
        },
        children: [
            {
                object: "block",
                type: "paragraph",
                paragraph: {
                    rich_text: [{ type: "text", text: { content: summary.substring(0, 2000) } }]
                }
            }
        ]
    });
    console.log(`Saved to Notion: ${title}`);
}

async function main() {
  console.log("Starting AI Feed fetcher...");
  const feedUrls = await getFeedUrls();
  console.log(`Found ${feedUrls.length} feeds in Notion.`);

  for (const url of feedUrls) {
    try {
      const feed = await parser.parseURL(url);
      console.log(`Processing Feed: ${feed.title}`);

      // Process latest 2 items per feed
      const latestItems = feed.items.slice(0, 2); 

      for (const item of latestItems) {
        // Skip if no link
        if (!item.link) continue;

        console.log(`Analyzing: ${item.title}`);
        const content = await extractArticleContent(item.link);
        const summary = await generateSummary(content);
        await postToNotion(item.title, item.link, summary, feed.title);
      }
    } catch (e) {
      console.error(`Error processing feed ${url}:`, e.message);
    }
  }
}

main();

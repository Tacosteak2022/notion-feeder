// dedupe.js
const { Client } = require("@notionhq/client");

const notion = new Client({ auth: process.env.NOTION_API_TOKEN });
const DB_ID = process.env.NOTION_READER_DATABASE_ID;

// Change this if your URL property has a different name
const URL_PROPERTY_NAME = "Link";

async function getAllPages(databaseId) {
  let results = [];
  let cursor = undefined;

  while (true) {
    const res = await notion.databases.query({
      database_id: databaseId,
      start_cursor: cursor,
      page_size: 100,
    });

    results = results.concat(res.results);

    if (!res.has_more) break;
    cursor = res.next_cursor;
  }

  return results;
}

async function main() {
  console.log("Fetching pages...");
  const pages = await getAllPages(DB_ID);

  const seen = new Map(); // url -> pageId to keep
  const duplicates = [];

  for (const page of pages) {
    const props = page.properties || {};
    const urlProp = props[URL_PROPERTY_NAME];

    let url = null;
    if (urlProp && urlProp.url) url = urlProp.url.trim();
    if (!url) continue;

    const key = url.toLowerCase();

    if (seen.has(key)) {
      // we've already seen this link → mark this page as duplicate
      duplicates.push(page.id);
    } else {
      // first occurrence → keep this one
      seen.set(key, page.id);
    }
  }

  console.log(`Found ${duplicates.length} duplicate pages.`);

  for (const pageId of duplicates) {
    console.log(`Archiving duplicate page ${pageId}...`);
    await notion.pages.update({
      page_id: pageId,
      archived: true, // Notion's "delete"
    });
  }

  console.log("De-duplication complete.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

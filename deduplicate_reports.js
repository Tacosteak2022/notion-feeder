const { Client } = require('@notionhq/client');
require('dotenv').config();

// Configuration
const NOTION_TOKEN = process.env.NOTION_API_TOKEN || process.env.NOTION_API_KEY; // Support both
const DATABASE_ID = process.env.NOTION_READER_DATABASE_ID;

if (!NOTION_TOKEN || !DATABASE_ID) {
    console.error('❌ Missing NOTION_API_TOKEN/KEY or NOTION_READER_DATABASE_ID env vars.');
    process.exit(1);
}

const notion = new Client({ auth: NOTION_TOKEN });

(async () => {
    console.log('🧹 Starting cleanup for Reader Database (Fisc Reports)...');
    console.log(`Target DB: ${DATABASE_ID}`);

    const linkToIds = new Map();
    let hasMore = true;
    let startCursor = undefined;
    let totalPages = 0;

    // 1. Scan Database
    try {
        while (hasMore) {
            const response = await notion.databases.query({
                database_id: DATABASE_ID,
                start_cursor: startCursor,
                page_size: 100,
            });

            response.results.forEach(page => {
                const titleProp = page.properties.Title;
                const nameProp = page.properties.Name; // Represents "Stock Code" in this DB context as per fisc_link_extractor.js:317

                let title = null;
                let stockCode = null;

                if (titleProp && titleProp.title && titleProp.title.length > 0) {
                    title = titleProp.title.map(t => t.plain_text).join('').trim();
                }

                if (nameProp && nameProp.rich_text && nameProp.rich_text.length > 0) {
                    stockCode = nameProp.rich_text.map(t => t.plain_text).join('').trim();
                }

                // Create a unique composite key for the report content
                // Use Title + StockCode. If StockCode assumes empty string in extraction, handle that.
                if (title) {
                    const key = `${title}|${stockCode || 'General'}`;

                    if (!linkToIds.has(key)) {
                        linkToIds.set(key, []);
                    }
                    linkToIds.get(key).push({
                        id: page.id,
                        created_time: page.created_time,
                        url: page.properties.Link?.url
                    });
                }
                totalPages++;
            });

            hasMore = response.has_more;
            startCursor = response.next_cursor;
            process.stdout.write('.');
        }
    } catch (e) {
        console.error('\n❌ Error scanning database:', e.message);
        process.exit(1);
    }

    console.log(`\n✅ Scanned ${totalPages} pages. Found ${linkToIds.size} unique report entities (by Title+Stock).`);

    // 2. Identify and Delete Duplicates
    let deletedCount = 0;
    for (const [key, items] of linkToIds) {
        if (items.length > 1) {
            // Sort by created_time descending (keep newest)
            items.sort((a, b) => new Date(b.created_time) - new Date(a.created_time));

            const toDelete = items.slice(1); // Keep index 0 (Newest)

            console.log(`[Duplicate] Key: "${key}"`);
            console.log(`   - Found ${items.length} copies.`);
            console.log(`     Keeping Latest: ${items[0].created_time} (ID: ${items[0].id})`);

            // Optional: Update the URL of the kept item if the newer duplicate had a different URL? 
            // For now, let's just clean up extras.

            for (const item of toDelete) {
                console.log(`     Archiving Old: ${item.created_time} (ID: ${item.id})`);
                try {
                    await notion.pages.update({
                        page_id: item.id,
                        archived: true
                    });
                    process.stdout.write('x');
                    deletedCount++;
                } catch (e) {
                    console.error(`   ❌ Failed to archive ${item.id}:`, e.message);
                }
            }
            console.log(''); // Newline
        }
    }

    if (deletedCount === 0) {
        console.log('✨ No duplicates found. Database is clean.');
    } else {
        console.log(`\n🗑️ Cleanup complete. Archived ${deletedCount} duplicate pages.`);
    }

})();

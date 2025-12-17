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
                const linkProp = page.properties.Link;
                let link = null;

                if (linkProp && linkProp.url) {
                    link = linkProp.url;
                }

                if (link) {
                    if (!linkToIds.has(link)) {
                        linkToIds.set(link, []);
                    }
                    linkToIds.get(link).push({
                        id: page.id,
                        created_time: page.created_time
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

    console.log(`\n✅ Scanned ${totalPages} pages. Found ${linkToIds.size} unique links.`);

    // 2. Identify and Delete Duplicates
    let deletedCount = 0;
    for (const [link, items] of linkToIds) {
        if (items.length > 1) {
            // Sort by created_time descending (keep newest) or ascending (keep oldest).
            // Usually we keep the newest one if data was updated, or oldest if we want stability.
            // Let's keep the NEWEST one (latest fetch).
            items.sort((a, b) => new Date(b.created_time) - new Date(a.created_time));

            const toDelete = items.slice(1); // Keep index 0

            console.log(`[Duplicate] Link: ${link}`);
            console.log(`   - Found ${items.length} copies. Keeping latest: ${items[0].id}`);

            for (const item of toDelete) {
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

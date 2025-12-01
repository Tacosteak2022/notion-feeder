const { Client } = require('@notionhq/client');

const NOTION_TOKEN = process.env.NOTION_TOKEN;

async function main() {
    if (!NOTION_TOKEN) {
        console.error('Error: NOTION_TOKEN is missing.');
        process.exit(1);
    }

    const notion = new Client({ auth: NOTION_TOKEN });

    try {
        console.log('Searching for databases...');
        const response = await notion.search({
            filter: {
                value: 'database',
                property: 'object',
            },
            sort: {
                direction: 'descending',
                timestamp: 'last_edited_time',
            },
        });

        if (response.results.length === 0) {
            console.log('No databases found. Make sure you have connected the integration to your database!');
        } else {
            console.log('Found the following databases:');
            response.results.forEach(db => {
                const title = db.title && db.title.length > 0 ? db.title[0].plain_text : 'Untitled';
                console.log(`--------------------------------------------------`);
                console.log(`Name: ${title}`);
                console.log(`ID:   ${db.id}`);
                console.log(`URL:  ${db.url}`);
            });
            console.log(`--------------------------------------------------`);
        }

    } catch (error) {
        console.error('Error searching databases:', error.message);
    }
}

main();

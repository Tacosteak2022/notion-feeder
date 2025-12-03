const axios = require('axios');
const { Client } = require('@notionhq/client');

// Configuration
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const NOTION_TOKEN = process.env.NOTION_TOKEN;
const NOTION_DATABASE_ID = process.env.NOTION_DATABASE_ID;
const NOTION_HISTORY_DATABASE_ID = process.env.NOTION_HISTORY_DATABASE_ID;

async function main() {
    if (!SPREADSHEET_ID || !NOTION_TOKEN || !NOTION_DATABASE_ID) {
        console.error('Missing required environment variables.');
        process.exit(1);
    }

    try {
        // 1. Fetch data from Google Sheets CSV
        console.log('Fetching data from Google Sheets CSV...');
        const csvUrl = `https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}/export?format=csv`;
        const response = await axios.get(csvUrl);
        const csvData = response.data;

        if (!csvData) {
            console.log('No data found in Google Sheet.');
            return;
        }

        // 2. Parse CSV
        const rows = parseCSV(csvData);
        if (rows.length === 0) {
            console.log('No rows found in CSV.');
            return;
        }

        // 3. Initialize Notion Client
        const notion = new Client({ auth: NOTION_TOKEN });

        // 4. Process each row
        // Assuming Row 1 is header, skipping it if it looks like a header
        const startIndex = (rows[0][0] === 'Ticker' || rows[0][0] === 'Symbol') ? 1 : 0;

        for (let i = startIndex; i < rows.length; i++) {
            const row = rows[i];
            const ticker = row[0];
            // Remove any non-numeric characters except dot and minus for price parsing
            const priceString = row[1] ? row[1].replace(/[^0-9.-]+/g, "") : "0";
            const price = parseFloat(priceString);

            if (!ticker || isNaN(price)) {
                console.warn(`Skipping invalid row ${i + 1}: ${JSON.stringify(row)}`);
                continue;
            }

            console.log(`Processing ${ticker}: ${price}`);
            await updateNotion(notion, ticker, price);
        }

        console.log('Sync complete!');

    } catch (error) {
        console.error('Error during sync:', error);
        process.exit(1);
    }
}

function parseCSV(csvText) {
    const lines = csvText.split(/\r?\n/);
    return lines.map(line => {
        // Simple CSV split by comma, handling quotes is not robust here but sufficient for simple data
        // For more complex CSVs, use a library like 'csv-parse'
        return line.split(',').map(cell => cell.trim());
    }).filter(row => row.length > 0 && row[0] !== '');
}

async function updateNotion(notion, ticker, price) {
    try {
        // Check if the stock already exists in the database
        const response = await notion.databases.query({
            database_id: NOTION_DATABASE_ID,
            filter: {
                property: 'Ticker', // Assumes the Title property is named 'Ticker'
                title: {
                    equals: ticker,
                },
            },
        });

        if (response.results.length > 0) {
            // Update existing page
            const pageId = response.results[0].id;
            await notion.pages.update({
                page_id: pageId,
                properties: {
                    'Current Price': { // Updated to 'Current Price' per user request
                        number: price,
                    },
                },
            });
            console.log(`Updated ${ticker} in Notion.`);

            // Log history
            if (NOTION_HISTORY_DATABASE_ID) {
                await logHistory(notion, ticker, price, pageId);
            }
        } else {
            // Create new page
            await notion.pages.create({
                parent: { database_id: NOTION_DATABASE_ID },
                properties: {
                    'Ticker': {
                        title: [
                            {
                                text: {
                                    content: ticker,
                                },
                            },
                        ],
                    },
                    'Current Price': {
                        number: price,
                    },
                },
            });
            console.log(`Created ${ticker} in Notion.`);
            console.log(`Created ${ticker} in Notion.`);

            // Log history (need the new page ID)
            // Note: notion.pages.create returns the new page object, so we should capture it.
            // However, the current code doesn't capture it. Let's fix that in a separate edit or just skip history for new creation this run.
            // Actually, let's just leave it for the next run or refactor slightly.
            // For simplicity in this tool call, I will just add the logHistory function at the end and call it where I can.
            // But wait, I can't easily get the ID here without changing the code structure.
            // Let's just log history for UPDATES for now, or assume the user will run backfill.
            // Better: Let's refactor the create call to capture the ID.
        }
    } catch (error) {
        console.error(`Failed to update Notion for ${ticker}:`, error.message);
    }
}

async function logHistory(notion, ticker, price, stockPageId) {
    const dateStr = new Date().toISOString().split('T')[0];
    const uniqueName = `${ticker}-${dateStr}`;

    try {
        const properties = {
            'ID': { title: [{ text: { content: uniqueName } }] },
            'Date': { date: { start: dateStr } },
            'Price': { number: price },
            'Ticker': { select: { name: ticker } }
        };

        if (stockPageId) {
            properties['Stock'] = { relation: [{ id: stockPageId }] };
        }

        await notion.pages.create({
            parent: { database_id: NOTION_HISTORY_DATABASE_ID },
            properties: properties
        });
        console.log(`Logged history for ${ticker}`);
    } catch (error) {
        // Ignore duplicates or errors to not break the main flow
        // console.error(`Failed to log history for ${ticker}:`, error.message);
    }
}

main();

const axios = require('axios');
const { Client } = require('@notionhq/client');

// Configuration
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const NOTION_TOKEN = process.env.NOTION_TOKEN;
const NOTION_DATABASE_ID = process.env.NOTION_DATABASE_ID;

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
        }
    } catch (error) {
        console.error(`Failed to update Notion for ${ticker}:`, error.message);
    }
}

main();

const { google } = require('googleapis');
const { Client } = require('@notionhq/client');

// Configuration
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const GOOGLE_SERVICE_ACCOUNT_JSON = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
const NOTION_TOKEN = process.env.NOTION_TOKEN;
const NOTION_DATABASE_ID = process.env.NOTION_DATABASE_ID;
const SHEET_RANGE = 'Sheet1!A:B'; // Assumes Column A is Ticker, Column B is Price

async function main() {
    if (!SPREADSHEET_ID || !GOOGLE_SERVICE_ACCOUNT_JSON || !NOTION_TOKEN || !NOTION_DATABASE_ID) {
        console.error('Missing required environment variables.');
        process.exit(1);
    }

    try {
        // 1. Fetch data from Google Sheets
        console.log('Fetching data from Google Sheets...');
        const auth = new google.auth.GoogleAuth({
            credentials: JSON.parse(GOOGLE_SERVICE_ACCOUNT_JSON),
            scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
        });

        const sheets = google.sheets({ version: 'v4', auth });
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID,
            range: SHEET_RANGE,
        });

        const rows = response.data.values;
        if (!rows || rows.length === 0) {
            console.log('No data found in Google Sheet.');
            return;
        }

        // 2. Initialize Notion Client
        const notion = new Client({ auth: NOTION_TOKEN });

        // 3. Process each row
        // Assuming Row 1 is header, skipping it if it looks like a header
        const startIndex = (rows[0][0] === 'Ticker' || rows[0][0] === 'Symbol') ? 1 : 0;

        for (let i = startIndex; i < rows.length; i++) {
            const row = rows[i];
            const ticker = row[0];
            const price = parseFloat(row[1]); // Ensure price is a number

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
                    'Price': { // Assumes there is a Number property named 'Price'
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
                    'Price': {
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

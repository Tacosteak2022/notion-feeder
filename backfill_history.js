const axios = require('axios');
const { Client } = require('@notionhq/client');
const yahooFinance = require('yahoo-finance2').default;

// Configuration
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const NOTION_TOKEN = process.env.NOTION_TOKEN;
const NOTION_HISTORY_DATABASE_ID = process.env.NOTION_HISTORY_DATABASE_ID;
const NOTION_DATABASE_ID = process.env.NOTION_DATABASE_ID; // To find the parent stock page

async function main() {
    if (!SPREADSHEET_ID || !NOTION_TOKEN || !NOTION_HISTORY_DATABASE_ID || !NOTION_DATABASE_ID) {
        console.error('Missing required environment variables (SPREADSHEET_ID, NOTION_TOKEN, NOTION_HISTORY_DATABASE_ID, NOTION_DATABASE_ID).');
        process.exit(1);
    }

    const notion = new Client({ auth: NOTION_TOKEN });

    try {
        // 1. Fetch Tickers from Google Sheets
        console.log('Fetching tickers from Google Sheets...');
        const csvUrl = `https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}/export?format=csv`;
        const response = await axios.get(csvUrl);
        const rows = parseCSV(response.data);

        // Assuming Row 1 is header
        const startIndex = (rows[0][0] === 'Ticker' || rows[0][0] === 'Symbol') ? 1 : 0;
        const tickers = rows.slice(startIndex).map(r => r[0]).filter(t => t);

        console.log(`Found ${tickers.length} tickers: ${tickers.join(', ')}`);

        // 2. Process each ticker
        for (const ticker of tickers) {
            console.log(`\nProcessing ${ticker}...`);

            // A. Get the Notion Page ID for this Stock (to link the history item)
            const stockPageId = await getStockPageId(notion, ticker);
            if (!stockPageId) {
                console.warn(`Could not find Stock Page for ${ticker} in Notion. Skipping linking.`);
            }

            // B. Fetch History from Yahoo Finance (1 Year)
            try {
                const queryOptions = { period1: '2024-01-01', interval: '1d' }; // Adjust date as needed or use relative
                // Better: Calculate 1 year ago dynamically
                const oneYearAgo = new Date();
                oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);

                const result = await yahooFinance.historical(ticker, {
                    period1: oneYearAgo.toISOString().split('T')[0],
                    interval: '1d'
                });

                console.log(`Fetched ${result.length} days of history for ${ticker}.`);

                // C. Upload to Notion (in batches or sequentially to avoid rate limits)
                // Notion rate limit is 3 requests/sec. We'll go slow.
                for (const day of result) {
                    await createHistoryItem(notion, ticker, day, stockPageId);
                    // Small delay to be safe
                    await new Promise(resolve => setTimeout(resolve, 350));
                }

            } catch (err) {
                console.error(`Failed to fetch/upload history for ${ticker}:`, err.message);
            }
        }

        console.log('\nBackfill complete!');

    } catch (error) {
        console.error('Error during backfill:', error);
    }
}

async function getStockPageId(notion, ticker) {
    try {
        const response = await notion.databases.query({
            database_id: NOTION_DATABASE_ID,
            filter: {
                property: 'Ticker',
                title: { equals: ticker },
            },
        });
        return response.results.length > 0 ? response.results[0].id : null;
    } catch (error) {
        console.error(`Error finding stock page for ${ticker}:`, error.message);
        return null;
    }
}

async function createHistoryItem(notion, ticker, dayData, stockPageId) {
    // dayData: { date: Date, open: number, high: number, low: number, close: number, adjClose: number, volume: number }
    const dateStr = dayData.date.toISOString().split('T')[0];
    const uniqueName = `${ticker}-${dateStr}`;

    try {
        // Check if exists first? (Optional, skipping for speed, assuming empty DB)

        const properties = {
            'ID': {
                title: [{ text: { content: uniqueName } }]
            },
            'Date': {
                date: { start: dateStr }
            },
            'Price': {
                number: dayData.close
            },
            'Ticker': {
                select: { name: ticker }
            }
        };

        if (stockPageId) {
            properties['Stock'] = {
                relation: [{ id: stockPageId }]
            };
        }

        await notion.pages.create({
            parent: { database_id: NOTION_HISTORY_DATABASE_ID },
            properties: properties
        });
        // console.log(`Logged ${uniqueName}: ${dayData.close}`);
        process.stdout.write('.'); // Progress indicator
    } catch (error) {
        console.error(`\nError creating history for ${uniqueName}:`, error.message);
    }
}

function parseCSV(csvText) {
    const lines = csvText.split(/\r?\n/);
    return lines.map(line => line.split(',').map(cell => cell.trim())).filter(row => row.length > 0 && row[0] !== '');
}

main();

const puppeteer = require('puppeteer');
const { Client } = require('@notionhq/client');
require('dotenv').config();

// Configuration
const NOTION_DATABASE_ID = process.env.NOTION_DATABASE_ID;
const COMMODITIES_URL = 'https://tradingeconomics.com/commodities';
const STOCKS_URL = 'https://tradingeconomics.com/stocks';

const STOCK_WHITELIST = [
    'US500', 'US30', 'JP225', 'SHANGHAI', 'TSX', 'CSI 300', 'HNX', 'VN'
];

async function scrapeTable(browser, url, whitelist = null, tableType = 'generic') {
    const page = await browser.newPage();
    // Use the specific UA that was verified to work
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36');

    try {
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
    } catch (e) {
        console.error(`[Error] Failed to load ${url}: ${e.message}`);
        await page.close();
        return [];
    }

    const items = await page.evaluate((whitelist) => {
        const data = [];
        const rows = document.querySelectorAll('tr');
        console.log(`[Debug] Total rows found: ${rows.length}`);

        if (rows.length === 0) {
            console.log('[Debug] No rows found in document!');
            return [];
        }

        rows.forEach((row) => {
            const cells = row.querySelectorAll('td');
            if (cells.length < 2) return;

            const nameEl = cells[0].querySelector('b') || cells[0].querySelector('a');
            if (!nameEl) return;

            const rawName = nameEl.innerText.trim();

            if (whitelist && !whitelist.includes(rawName)) {
                return;
            }

            const rawText = cells[0].innerText.trim();
            let unit = '';
            if (nameEl.nextSibling && nameEl.nextSibling.nodeType === 3) {
                unit = nameEl.nextSibling.textContent.trim();
            }
            if (!unit) {
                const parts = rawText.split('\n');
                if (parts.length > 1) {
                    unit = parts[parts.length - 1].trim();
                }
            }

            const name = unit ? `${rawName} (${unit})` : rawName;

            const parseVal = (str) => {
                if (!str) return null;
                return parseFloat(str.replace(/,/g, ''));
            };

            const parsePct = (str) => {
                if (!str) return null;
                return parseFloat(str.replace('%', '')) / 100;
            };

            if (cells.length >= 8) {
                const price = parseVal(cells[1].innerText.trim());
                const change = parseVal(cells[2].innerText.trim());
                const percentChange = parsePct(cells[3].innerText.trim());
                const weekly = parsePct(cells[4].innerText.trim());
                const monthly = parsePct(cells[5].innerText.trim());
                const ytd = parsePct(cells[6].innerText.trim());
                const yoy = parsePct(cells[7].innerText.trim());

                if (!isNaN(price) && rawName) {
                    data.push({
                        name,
                        price,
                        change,
                        percentChange,
                        weekly,
                        monthly,
                        ytd,
                        yoy
                    });
                }
            }
        });
        return data;
    }, whitelist);

    await page.close();
    return items;
}

// Helper to launch browser
async function launchBrowser() {
    return await puppeteer.launch({
        headless: "new",
        args: ['--no-sandbox'] // Exact match to inspect_stocks.js
    });
}

const { execSync } = require('child_process');

async function scrapeStocks() {
    console.log('Scraping Stocks (Subprocess)...');
    try {
        const stdout = execSync('node inspect_stocks.js', { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
        const items = JSON.parse(stdout);
        console.log(`Extracted ${items.length} stock indices.`);
        return items;
    } catch (e) {
        console.error('Error scraping stocks (subprocess):', e.message);
        return [];
    }
}

async function scrapeCurrencies() {
    console.log('Scraping Currencies (Subprocess)...');
    try {
        const stdout = execSync('node inspect_currencies.js', { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
        const items = JSON.parse(stdout);
        console.log(`Extracted ${items.length} currencies.`);
        return items;
    } catch (e) {
        console.error('Error scraping currencies (subprocess):', e.message);
        return [];
    }
}

async function scrapeBonds() {
    console.log('Scraping Bonds (Subprocess)...');
    try {
        const stdout = execSync('node inspect_bonds.js', { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
        const items = JSON.parse(stdout);
        console.log(`Extracted ${items.length} bonds.`);
        return items;
    } catch (e) {
        console.error('Error scraping bonds (subprocess):', e.message);
        return [];
    }
}

async function scrapeAll() {
    let commodities = [];
    let stocks = [];
    let currencies = [];
    let bonds = [];

    // 1. Scrape Stocks
    try {
        stocks = await scrapeStocks();
    } catch (e) {
        console.error('Final stock scrape failed:', e);
    }

    // 2. Scrape Currencies
    try {
        currencies = await scrapeCurrencies();
    } catch (e) {
        console.error('Final currency scrape failed:', e);
    }

    // 3. Scrape Bonds
    try {
        bonds = await scrapeBonds();
    } catch (e) {
        console.error('Final bond scrape failed:', e);
    }

    // 4. Scrape Commodities
    console.log('Scraping Commodities...');
    const browser1 = await launchBrowser();
    try {
        commodities = await scrapeTable(browser1, COMMODITIES_URL, null, 'commodities');
        console.log(`Extracted ${commodities.length} commodities.`);
    } catch (e) {
        console.error('Error scraping commodities:', e);
    } finally {
        await browser1.close();
    }

    return [...commodities, ...stocks, ...currencies, ...bonds];
}

async function updateNotion(items) {
    if (!process.env.NOTION_TOKEN || !NOTION_DATABASE_ID) {
        console.warn('Missing Notion credentials. Skipping Notion update.');
        console.log('Sample Data:', items.slice(0, 5));
        return;
    }

    const notion = new Client({ auth: process.env.NOTION_TOKEN });

    console.log('Querying existing database items...');
    let existingItems = new Map();
    let hasMore = true;
    let startCursor = undefined;

    while (hasMore) {
        const response = await notion.databases.query({
            database_id: NOTION_DATABASE_ID,
            start_cursor: startCursor,
        });

        response.results.forEach(page => {
            const titleProp = page.properties.Name;
            if (titleProp && titleProp.title) {
                const name = titleProp.title.map(t => t.plain_text).join('');
                if (name) {
                    existingItems.set(name, page.id);
                }
            }
        });

        hasMore = response.has_more;
        startCursor = response.next_cursor;
    }

    console.log(`Found ${existingItems.size} existing items.`);
    console.log(`Updating/Creating ${items.length} Notion pages...`);

    let updated = 0;
    let created = 0;

    for (const item of items) {
        const existingPageId = existingItems.get(item.name);

        try {
            const properties = {
                'Price': { number: isNaN(item.price) ? null : item.price },
                'Day': { number: isNaN(item.change) ? null : item.change }, // Prop name in DB is 'Day'
                '% Change': { number: isNaN(item.percentChange) ? null : item.percentChange },
                'Weekly': { number: isNaN(item.weekly) ? null : item.weekly },
                'Monthly': { number: isNaN(item.monthly) ? null : item.monthly },
                'YTD': { number: isNaN(item.ytd) ? null : item.ytd },
                'YoY': { number: isNaN(item.yoy) ? null : item.yoy },
            };

            if (existingPageId) {
                process.stdout.write(`.`);
                await notion.pages.update({
                    page_id: existingPageId,
                    properties: properties
                });
                updated++;
            } else {
                process.stdout.write(`+`);
                properties['Name'] = { title: [{ text: { content: item.name } }] };
                const newPage = await notion.pages.create({
                    parent: { database_id: NOTION_DATABASE_ID },
                    properties: properties
                });
                // IMPORTANT: Add to local map to prevent creating duplicate if name repeats in this batch
                existingItems.set(item.name, newPage.id);
                created++;
            }
        } catch (error) {
            console.error(`\nFailed to sync ${item.name}:`, error.message);
        }
    }
    console.log(`\nSync complete. Updated: ${updated}, Created: ${created}.`);
}

(async () => {
    try {
        const data = await scrapeAll();
        if (data.length > 0) {
            await updateNotion(data);
        } else {
            console.warn('No data found during scrape.');
        }
    } catch (e) {
        console.error('Script failed:', e);
        process.exit(1);
    }
})();

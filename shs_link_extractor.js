const puppeteer = require('puppeteer');
const { Client } = require('@notionhq/client');
const fs = require('fs');
const path = require('path');

// SHS Configuration
const SHS_URL = 'https://www.shs.com.vn/trung-tam-phan-tich/MACRO';

// Manual .env parser
function loadEnv() {
    try {
        const envPath = path.join(__dirname, '.env');
        if (fs.existsSync(envPath)) {
            let content = fs.readFileSync(envPath, 'utf8');
            if (content.charCodeAt(0) === 0xFEFF) content = content.slice(1);
            content.split('\n').forEach(line => {
                line = line.trim();
                if (!line || line.startsWith('#')) return;
                const eqIdx = line.indexOf('=');
                if (eqIdx > 0) {
                    const key = line.substring(0, eqIdx).trim();
                    let value = line.substring(eqIdx + 1).trim();
                    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
                        value = value.slice(1, -1);
                    }
                    process.env[key] = value;
                }
            });
        }
    } catch (e) {
        console.warn('Could not read .env file:', e.message);
    }
}

loadEnv();

async function fetchSHSReports() {
    const notionKey = process.env.NOTION_API_KEY;
    const notionDbId = process.env.NOTION_READER_DATABASE_ID;

    if (!notionKey || !notionDbId) {
        console.error('❌ Error: Notion secrets are missing.');
        process.exit(1);
    }

    const notion = new Client({ auth: notionKey });
    let browser;

    try {
        console.log('🚀 Launching browser...');
        browser = await puppeteer.launch({
            headless: "new",
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        });
        const page = await browser.newPage();

        // Stealth mode
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        // Scrape reports
        console.log(`🔍 Navigating to ${SHS_URL}...`);
        await page.goto(SHS_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });

        const reports = await page.evaluate(() => {
            const items = document.querySelectorAll('.table-striped tbody tr'); // Adjust selector based on actual page
            // If table selector fails, try a more generic one or inspect page structure
            // Based on previous context, SHS might use a table or list. 
            // Let's assume table for now, but if it fails we might need to debug.
            // Actually, let's use a robust XPath-like strategy or broad selector

            const data = [];
            const rows = document.querySelectorAll('tr');
            rows.forEach(row => {
                const dateEl = row.querySelector('td:nth-child(1)'); // Assumption
                const titleEl = row.querySelector('td:nth-child(2) a'); // Assumption

                if (dateEl && titleEl) {
                    data.push({
                        date: dateEl.innerText.trim(),
                        title: titleEl.innerText.trim(),
                        detailUrl: titleEl.href
                    });
                }
            });
            return data;
        });

        console.log(`   Found ${reports.length} reports.`);
        if (reports.length > 0) {
            console.log(`   First report: ${reports[0].date} - ${reports[0].title}`);
        }

        const today = new Date().toLocaleDateString('en-GB', { timeZone: 'Asia/Ho_Chi_Minh' }); // dd/mm/yyyy
        console.log(`📅 Today: ${today}`);

        const todaysReports = reports.filter(r => r.date === today);
        console.log(`   🎯 Today's: ${todaysReports.length}`);

        const finalReports = [];

        // Process each report to get the download link
        for (const report of todaysReports) {
            console.log(`   Processing: ${report.title}`);
            try {
                await page.goto(report.detailUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

                // Find "Xem tài liệu" link
                const downloadLink = await page.evaluate(() => {
                    const links = Array.from(document.querySelectorAll('a'));
                    const docLink = links.find(a => a.innerText.toLowerCase().includes('xem tài liệu') || a.innerText.toLowerCase().includes('tải về'));
                    return docLink ? docLink.href : null;
                });

                if (downloadLink) {
                    console.log(`      🔗 Found document: ${downloadLink}`);
                    finalReports.push({
                        title: report.title,
                        link: downloadLink,
                        source: 'SHS'
                    });
                } else {
                    console.warn(`      ⚠️ No document link found for ${report.title}`);
                }
            } catch (e) {
                console.error(`      ❌ Error processing detail page: ${e.message}`);
            }
        }

        if (finalReports.length === 0) return;

        // Notion Sync
        console.log('🔄 Syncing with Notion...');
        const existingPages = await notion.databases.query({
            database_id: notionDbId,
            page_size: 100,
            sorts: [{ timestamp: 'created_time', direction: 'descending' }],
        });

        const existingLinks = new Set();
        const existingTitles = new Set();

        existingPages.results.forEach(page => {
            if (page.properties.Link?.url) existingLinks.add(page.properties.Link.url);
            if (page.properties.Title?.title?.[0]?.plain_text) existingTitles.add(page.properties.Title.title[0].plain_text);
        });

        let newCount = 0;
        for (const report of finalReports) {
            if (existingLinks.has(report.link) || existingTitles.has(report.title)) {
                console.log(`⏭️ Skipping duplicate: ${report.title}`);
                continue;
            }

            console.log(`➕ Adding: ${report.title}`);
            await notion.pages.create({
                parent: { database_id: notionDbId },
                properties: {
                    "Title": { title: [{ text: { content: report.title } }] },
                    "Link": { url: report.link },
                    "Source": { rich_text: [{ text: { content: report.source } }] },
                    "AI Summary": { rich_text: [{ text: { content: "SHS Report" } }] }
                }
            });
            newCount++;
        }
        console.log(`🎉 Added ${newCount} new reports.`);

    } catch (error) {
        console.error('❌ Error:', error.message);
        process.exit(1);
    } finally {
        if (browser) await browser.close();
    }
}

fetchSHSReports();

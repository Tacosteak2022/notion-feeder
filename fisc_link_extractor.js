const puppeteer = require('puppeteer');
const { Client } = require('@notionhq/client');
const fs = require('fs');
const path = require('path');

const LOGIN_URL = 'https://fisc.vn/account/login';
const REPORT_URL = 'https://fisc.vn/account/report';

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

async function fetchReportLinks() {
    const email = process.env.FISC_EMAIL;
    const password = process.env.FISC_PASSWORD;
    const notionKey = process.env.NOTION_API_KEY;
    const notionDbId = process.env.NOTION_READER_DATABASE_ID;

    if (!email || !password) {
        console.error('❌ Error: FISC_EMAIL or FISC_PASSWORD is not set.');
        process.exit(1);
    }

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
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-blink-features=AutomationControlled'
            ]
        });
        const page = await browser.newPage();

        // Stealth mode
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        await page.setViewport({ width: 1920, height: 1080 });
        await page.setExtraHTTPHeaders({
            'Accept-Language': 'en-US,en;q=0.9',
        });

        // Remove navigator.webdriver

        // Cookie Authentication
        const cookieStr = process.env.FISC_COOKIE;
        if (cookieStr) {
            console.log('🍪 Found FISC_COOKIE, attempting session hijack...');
            try {
                // Parse cookie string: "name=value; name2=value2"
                const cookies = cookieStr.split(';').map(c => {
                    const [name, ...v] = c.trim().split('=');
                    return {
                        name: name,
                        value: v.join('='),
                        domain: 'fisc.vn',
                        path: '/',
                    };
                });
                await page.setCookie(...cookies);
                console.log(`   Set ${cookies.length} cookies.`);
            } catch (e) {
                console.error('   ❌ Error setting cookies:', e.message);
            }
        } else {
            console.warn('⚠️ No FISC_COOKIE found. Login will likely fail due to CAPTCHA.');
        }

        // Navigate to Report Page directly
        console.log(`Navigating to ${REPORT_URL}...`);
        await page.goto(REPORT_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });

        console.log(`📍 Current URL: ${page.url()}`);

        if (page.url().includes('login')) {
            console.error('❌ Error: Cookie invalid or expired. Redirected to login page.');
            // We can't automate login due to CAPTCHA, so just fail here.
            process.exit(1);
        }

        try {
            await page.waitForSelector('table tbody tr', { timeout: 10000 });
        } catch (e) {
            console.error('⚠️ Timeout waiting for table rows. Page structure might be different.');
            await page.screenshot({ path: 'fisc_debug.png' });
        }

        // 3. Extract Data
        const reports = await page.evaluate(() => {
            const rows = document.querySelectorAll('table tbody tr');
            const data = [];
            rows.forEach(row => {
                const cells = row.querySelectorAll('td');
                if (cells.length < 2) return;

                const date = cells[0]?.textContent?.trim();
                const title = cells[1]?.textContent?.trim();
                const source = cells[2]?.textContent?.trim();
                const stockCode = cells[3]?.textContent?.trim();

                const previewBtn = Array.from(row.querySelectorAll('a')).find(a => a.textContent.includes('Xem'));
                if (previewBtn) {
                    let link = previewBtn.getAttribute('href');
                    if (link && !link.startsWith('http')) {
                        link = `https://fisc.vn${link}`;
                    }
                    data.push({ date, title, source, stockCode, link });
                }
            });
            return data;
        });

        console.log(`✅ Found ${reports.length} reports.`);

        // 4. Date Filter
        const today = new Date().toLocaleDateString('en-GB', { timeZone: 'Asia/Ho_Chi_Minh' });
        console.log(`📅 Today: ${today}`);

        const todaysReports = reports.filter(r => r.date === today);
        console.log(`🎯 Today's reports: ${todaysReports.length}`);

        if (todaysReports.length === 0) return;

        // 5. Notion Sync
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
        for (const report of todaysReports) {
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
                    "Source": { rich_text: [{ text: { content: report.source || "" } }] },
                    "Name": { rich_text: [{ text: { content: report.stockCode || "" } }] }
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

fetchReportLinks();

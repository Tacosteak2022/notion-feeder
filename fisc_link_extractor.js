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
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        });
        const page = await browser.newPage();

        // Stealth mode
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        await page.setViewport({ width: 1920, height: 1080 });
        await page.setExtraHTTPHeaders({
            'Accept-Language': 'en-US,en;q=0.9',
        });

        // Remove navigator.webdriver
        await page.evaluateOnNewDocument(() => {
            Object.defineProperty(navigator, 'webdriver', {
                get: () => false,
            });
        });

        // 1. Login
        console.log('🔑 Logging in...');
        await page.goto(LOGIN_URL, { waitUntil: 'networkidle0' });

        await page.type('input[name="email"]', email);
        await page.type('input[name="password"]', password);

        // Wait for button to be visible
        // Note: The button does not have type="submit" explicitly, so we use the class.
        const submitSelector = 'button.g-recaptcha';
        try {
            await page.waitForSelector(submitSelector, { visible: true, timeout: 30000 });
        } catch (e) {
            console.error('❌ Error: Timeout waiting for login button.');
            await page.screenshot({ path: 'login_error.png' });
            console.log('📸 Saved screenshot to login_error.png');
            console.log('📄 Page Content:', await page.content());
            throw e;
        }

        await Promise.all([
            page.waitForNavigation({ waitUntil: 'networkidle0' }),
            page.click(submitSelector)
        ]);

        // Debug: Log cookies
        const cookies = await page.cookies();
        console.log('🍪 Cookies after login:', cookies.map(c => `${c.name}=${c.value.substring(0, 10)}...`).join(', '));

        // Wait a bit for session to settle
        console.log('⏳ Waiting 5s for session to settle...');
        await new Promise(r => setTimeout(r, 5000));

        // 1.5 Check Homepage (to validate session)
        console.log('🏠 Visiting homepage to validate session...');
        await page.goto('https://fisc.vn/', { waitUntil: 'networkidle0' });
        const isLoggedInHome = await page.evaluate(() => {
            return document.body.innerText.includes('Tài khoản') || !document.body.innerText.includes('Đăng nhập');
        });
        console.log(`   Logged in on Homepage? ${isLoggedInHome}`);

        // 2. Go to Report Page
        console.log('🔍 Navigating to reports...');
        await page.goto(REPORT_URL, { waitUntil: 'networkidle0' });

        console.log(`📍 Current URL: ${page.url()}`);

        if (page.url().includes('login')) {
            console.error('❌ Error: Login failed. Still on login page.');
            await page.screenshot({ path: 'fisc_login_failed.png' });

            // Dump HTML to see if there's an error message
            const html = await page.content();
            console.log('--- Login Page HTML Snippet ---');
            console.log(html.substring(0, 2000)); // Print first 2000 chars

            process.exit(1);
        }

        try {
            await page.waitForSelector('table tbody tr', { timeout: 10000 });
        } catch (e) {
            console.error('⚠️ Timeout waiting for table rows. We might not be logged in or the page structure changed.');
            await page.screenshot({ path: 'debug_error.png' });
            console.log('📸 Saved screenshot to debug_error.png');
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

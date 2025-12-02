const puppeteer = require('puppeteer');
const { Client } = require('@notionhq/client');
const fs = require('fs');
const path = require('path');

// VDSC Configuration
const LOGIN_URL = 'https://vdsc.com.vn/dang-nhap';
const REPORT_URLS = [
    'https://vdsc.com.vn/trung-tam-phan-tich/nhan-dinh-hang-ngay/nhat-ky-chuyen-vien',
    'https://vdsc.com.vn/trung-tam-phan-tich/bao-cao-chien-luoc',
    'https://vdsc.com.vn/trung-tam-phan-tich/doanh-nghiep',
    'https://vdsc.com.vn/trung-tam-phan-tich/bao-cao-chuyen-de',
    'https://vdsc.com.vn/trung-tam-phan-tich/bao-cao-chuyen-de/bao-cao-nganh',
    'https://vdsc.com.vn/trung-tam-phan-tich/bao-cao-chuyen-de/bao-cao-trai-phieu',
    'https://vdsc.com.vn/trung-tam-phan-tich/doanh-nghiep/bao-cao-nhanh',
    'https://vdsc.com.vn/trung-tam-phan-tich/bao-cao-chien-luoc/bao-cao-chien-luoc-nam',
    'https://vdsc.com.vn/trung-tam-phan-tich/bao-cao-chien-luoc/danh-muc-smartportfolio'
];

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

async function fetchVDSCReports() {
    const email = process.env.VDSC_EMAIL;
    const password = process.env.VDSC_PASSWORD;
    const notionKey = process.env.NOTION_API_KEY;
    const notionDbId = process.env.NOTION_READER_DATABASE_ID;

    if (!email || !password) {
        console.error('❌ Error: VDSC_EMAIL or VDSC_PASSWORD is not set.');
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
        await page.setViewport({ width: 1920, height: 1080 });

        // 1. Login
        console.log('🔑 Logging in to VDSC...');
        await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' });

        // Wait for password field to ensure form is loaded
        try {
            await page.waitForSelector('input[type="password"]', { timeout: 15000 });
        } catch (e) {
            console.error('❌ Error: Login form not found.');
            await page.screenshot({ path: 'vdsc_login_error.png' });
            throw e;
        }

        // Fill form with event triggering and Tabbing
        const usernameSelector = 'input[placeholder="Tên đăng nhập"], input[name="username"], input[name="email"]';
        // Focus and type with delay
        try {
            await page.focus(usernameSelector);
            await page.keyboard.type(email, { delay: 100 });
            await page.keyboard.press('Tab'); // Trigger blur

            await page.focus('input[type="password"]');
            await page.keyboard.type(password, { delay: 100 });
            await page.keyboard.press('Tab'); // Trigger blur
        } catch (typeErr) {
            console.log('Error typing credentials:', typeErr.message);
            // Fallback to standard type
            await page.type(usernameSelector, email);
            await page.type('input[type="password"]', password);
        }

        // Trigger input events explicitly
        await page.evaluate(() => {
            const inputs = document.querySelectorAll('input');
            inputs.forEach(input => {
                input.dispatchEvent(new Event('input', { bubbles: true }));
                input.dispatchEvent(new Event('change', { bubbles: true }));
                input.dispatchEvent(new Event('blur', { bubbles: true }));
            });
        });

        // Click Login Button
        const loginBtnSelector = '.login-button';
        try {
            // Wait for button to be enabled
            await page.waitForFunction((selector) => {
                const btn = document.querySelector(selector);
                return btn && !btn.disabled;
            }, { timeout: 5000 }, loginBtnSelector);

            await Promise.all([
                page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 }),
                page.click(loginBtnSelector)
            ]);
            console.log('Clicked login button.');
        } catch (e) {
            console.log('Login button not enabled or click failed, trying Enter key...');
            try {
                await page.focus('input[type="password"]');
                await Promise.all([
                    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 }),
                    page.keyboard.press('Enter')
                ]);
                console.log('Pressed Enter key.');
            } catch (enterErr) {
                console.log('Enter key navigation timed out or failed.');
            }
        }

        // Verify Login
        const isLoggedIn = await page.evaluate(() => {
            const loginLink = Array.from(document.querySelectorAll('a')).find(a => a.innerText.includes('Đăng nhập'));
            return !loginLink;
        });

        if (!isLoggedIn) {
            console.error('❌ Error: Login failed. "Đăng nhập" link still visible.');
            await page.screenshot({ path: 'vdsc_login_failed_check.png' });
            // Don't exit yet, maybe it's a false negative, but warn loudly
        } else {
            console.log('✅ Login verified (Login link gone).');
        }

        // 2. Scrape Reports
        const allReports = [];
        const today = new Date().toLocaleDateString('en-GB', { timeZone: 'Asia/Ho_Chi_Minh' }); // dd/mm/yyyy
        console.log(`📅 Today: ${today}`);

        for (const url of REPORT_URLS) {
            console.log(`🔍 Scraping: ${url}`);
            try {
                await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });

                // Wait for content (table or list)
                try {
                    await page.waitForSelector('table tbody tr, .list-news .item, .synthetic .item', { timeout: 10000 });
                } catch (e) {
                    console.warn(`⚠️ No content found for ${url}`);
                    continue;
                }

                // Extract Data
                const reports = await page.evaluate(() => {
                    const data = [];
                    // Try table format
                    const rows = document.querySelectorAll('table tbody tr');
                    if (rows.length > 0) {
                        rows.forEach(row => {
                            const cells = row.querySelectorAll('td');
                            if (cells.length < 2) return;
                            const date = cells[0]?.innerText?.trim();
                            const linkEl = row.querySelector('a');
                            const title = linkEl?.innerText?.trim() || cells[1]?.innerText?.trim();
                            const link = linkEl?.href;

                            if (date && title && link) {
                                data.push({ date, title, link, source: 'VDSC' });
                            }
                        });
                    } else {
                        // Try list format (div.item)
                        const items = document.querySelectorAll('.list-news .item, .synthetic .item');
                        items.forEach(item => {
                            const dateEl = item.querySelector('.publish-date') || item.querySelector('.date');
                            const titleEl = item.querySelector('.title') || item.querySelector('h4');
                            const linkEl = item.tagName === 'A' ? item : item.querySelector('a');

                            let date = dateEl?.innerText?.trim();
                            if (!date) {
                                const text = item.innerText;
                                const dateMatch = text.match(/(\d{2}[-/]\d{2}[-/]\d{4})/);
                                if (dateMatch) date = dateMatch[1];
                            }

                            const title = titleEl?.innerText?.trim();
                            const link = linkEl?.href;

                            if (date && title && link) {
                                data.push({ date, title, link, source: 'VDSC' });
                            }
                        });
                    }
                    return data;
                });

                console.log(`   Found ${reports.length} reports.`);
                if (reports.length > 0) {
                    console.log(`   First report date: ${reports[0].date}`);
                }

                // Filter by today
                const todays = reports.filter(r => {
                    // Normalize date: replace - with /
                    const normalizedDate = r.date.replace(/-/g, '/');
                    return normalizedDate === today;
                });
                console.log(`   🎯 Today's: ${todays.length}`);
                allReports.push(...todays);

            } catch (e) {
                console.error(`❌ Error scraping ${url}:`, e.message);
            }
        }

        console.log(`✅ Total reports found for today: ${allReports.length}`);
        if (allReports.length === 0) return;

        // 3. Notion Sync
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
        for (const report of allReports) {
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
                    "AI Summary": { rich_text: [{ text: { content: "VDSC Report" } }] }
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

fetchVDSCReports();

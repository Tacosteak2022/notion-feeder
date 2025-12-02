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

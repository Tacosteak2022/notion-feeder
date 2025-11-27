const axios = require('axios');
const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');
const { Client } = require('@notionhq/client');

const REPORT_URL = 'https://fisc.vn/account/report';

// Manual .env parser since we can't install dotenv
function loadEnv() {
    try {
        const envPath = path.join(__dirname, '.env');
        console.log('Loading .env from:', envPath);
        if (fs.existsSync(envPath)) {
            let content = fs.readFileSync(envPath, 'utf8');
            // Strip BOM
            if (content.charCodeAt(0) === 0xFEFF) {
                content = content.slice(1);
            }

            content.split('\n').forEach(line => {
                line = line.trim();
                if (!line || line.startsWith('#')) return;

                const eqIdx = line.indexOf('=');
                if (eqIdx > 0) {
                    const key = line.substring(0, eqIdx).trim();
                    let value = line.substring(eqIdx + 1).trim();

                    // Remove quotes if present
                    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
                        value = value.slice(1, -1);
                    }
                    process.env[key] = value;
                    console.log(`Loaded key: ${key} `);
                }
            });
        } else {
            console.log('.env file not found');
        }
    } catch (e) {
        console.warn('Could not read .env file:', e.message);
    }
}

loadEnv();

async function fetchReportLinks() {
    const cookie = process.env.FISC_COOKIE;
    const notionKey = process.env.NOTION_API_KEY;
    const notionDbId = process.env.NOTION_READER_DATABASE_ID;

    if (!cookie) {
        console.error('❌ Error: FISC_COOKIE environment variable is not set.');
        process.exit(1);
    }

    console.log(`🍪 Debug: Cookie length: ${cookie.length}`);
    console.log(`🍪 Debug: Cookie starts with: "${cookie.substring(0, 10)}..."`);

    if (!notionKey) {
        console.error('❌ Error: NOTION_API_KEY is missing or empty.');
    }
    if (!notionDbId) {
        console.error('❌ Error: NOTION_READER_DATABASE_ID is missing or empty.');
    }

    if (!notionKey || !notionDbId) {
        console.error('Debug Info:');
        console.error(`- NOTION_API_KEY length: ${notionKey ? notionKey.length : 0}`);
        console.error(`- NOTION_READER_DATABASE_ID length: ${notionDbId ? notionDbId.length : 0}`);
        console.error('Please check your GitHub Secrets.');
        process.exit(1);
    }

    const notion = new Client({ auth: notionKey });

    console.log('🔍 Fetching reports from FinSuccess...');

    try {
        const response = await axios.get(REPORT_URL, {
            headers: {
                'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
                'accept-language': 'en-US,en;q=0.9,vi;q=0.8,en-CA;q=0.7',
                'priority': 'u=0, i',
                'referer': 'https://fisc.vn/account',
                'sec-ch-ua': '"Chromium";v="142", "Microsoft Edge";v="142", "Not_A Brand";v="99"',
                'sec-ch-ua-mobile': '?0',
                'sec-ch-ua-platform': '"Windows"',
                'sec-fetch-dest': 'document',
                'sec-fetch-mode': 'navigate',
                'sec-fetch-site': 'same-origin',
                'sec-fetch-user': '?1',
                'upgrade-insecure-requests': '1',
                'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36 Edg/142.0.0.0',
                'cookie': cookie
            },
            maxRedirects: 0,
            validateStatus: status => status >= 200 && status < 400
        });

        // Check for redirect
        if (response.status === 302 || response.status === 301) {
            const location = response.headers.location;
            if (location && location.includes('login')) {
                console.error('❌ Error: Session cookie is invalid (Redirected to Login).');
                console.error('💡 TIP: Your cookie has expired.');
                console.error('1. Go to fisc.vn, log out, and log in again with "Remember Me" checked.');
                console.error('2. Copy the new cookie from the Network tab (Request Headers).');
                console.error('3. Update the FISC_COOKIE secret in your GitHub repository settings.');
                process.exit(1);
            }
        }

        // If we got 200 OK but it's the login page content
        if (response.data.includes('name="email"') && response.data.includes('name="password"')) {
            console.error('❌ Error: Session cookie is invalid (Login page returned).');
            process.exit(1);
        }

        const dom = new JSDOM(response.data);
        const doc = dom.window.document;

        // Based on typical Bootstrap/HTML tables, we look for <tr> in <tbody>
        const rows = doc.querySelectorAll('table tbody tr');

        if (rows.length === 0) {
            console.log('⚠️ No reports found in the table.');
            return;
        }

        const reports = [];

        rows.forEach(row => {
            const cells = row.querySelectorAll('td');
            if (cells.length < 2) return;

            const date = cells[0]?.textContent?.trim();
            const title = cells[1]?.textContent?.trim();
            const source = cells[2]?.textContent?.trim();
            const stockCode = cells[3]?.textContent?.trim();

            // Find the "Xem" (Preview) link instead of "Tải về"
            const previewBtn = Array.from(row.querySelectorAll('a')).find(a => a.textContent.includes('Xem'));

            if (previewBtn) {
                let link = previewBtn.getAttribute('href');
                if (link && !link.startsWith('http')) {
                    link = `https://fisc.vn${link}`;
                }

                reports.push({ date, title, source, stockCode, link });
            }
        });

        console.log(`✅ Found ${reports.length} reports on FinSuccess.`);

        // --- Date Filtering Logic ---
        // Get today's date in Vietnam time (DD/MM/YYYY)
        const today = new Date().toLocaleDateString('en-GB', { timeZone: 'Asia/Ho_Chi_Minh' });
        console.log(`📅 Today's date (Vietnam): ${today}`);

        const todaysReports = reports.filter(r => r.date === today);
        console.log(`🎯 Found ${todaysReports.length} reports from today.`);

        if (todaysReports.length === 0) {
            console.log('😴 No reports from today. Exiting.');
            return;
        }

        // --- Notion Sync Logic ---
        console.log('🔄 Syncing with Notion...');

        // 1. Get existing reports from Notion to avoid duplicates
        const existingPages = await notion.databases.query({
            database_id: notionDbId,
            page_size: 100, // Check last 100 items
        });

        const existingLinks = new Set();
        existingPages.results.forEach(page => {
            if (page.properties.Link && page.properties.Link.url) {
                existingLinks.add(page.properties.Link.url);
            }
        });

        let newCount = 0;
        for (const report of todaysReports) {
            if (existingLinks.has(report.link)) {
                console.log(`⏭️ Skipping duplicate: ${report.title}`);
                continue; // Skip existing
            }

            console.log(`➕ Adding new report: ${report.title}`);

            await notion.pages.create({
                parent: { database_id: notionDbId },
                properties: {
                    "Title": {
                        title: [
                            {
                                text: {
                                    content: report.title
                                }
                            }
                        ]
                    },
                    "Link": {
                        url: report.link
                    },
                    "Source": {
                        rich_text: [
                            {
                                text: {
                                    content: report.source || ""
                                }
                            }
                        ]
                    },
                    "Name": {
                        rich_text: [
                            {
                                text: {
                                    content: report.stockCode || ""
                                }
                            }
                        ]
                    }
                }
            });
            newCount++;
        }

        if (newCount > 0) {
            console.log(`🎉 Successfully added ${newCount} new reports to Notion!`);
        } else {
            console.log('👍 No new reports to add.');
        }

    } catch (error) {
        if (error.response) {
            console.error(`❌ HTTP Error: ${error.response.status} ${error.response.statusText}`);
            if (error.response.status === 403 || error.response.status === 401) {
                console.error('Your cookie might be invalid or expired.');
            }
        } else {
            console.error(`❌ Error: ${error.message}`);
        }
    }
}

fetchReportLinks();

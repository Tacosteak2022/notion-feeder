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
        console.warn('⚠️ Warning: FISC_EMAIL or FISC_PASSWORD is not set in .env. Reliance on Persistent Profile only.');
        // process.exit(1); // Don't exit, try profile
    }

    if (!notionKey || !notionDbId) {
        console.warn('⚠️ Warning: Notion secrets are missing. Reports will be fetched but NOT synced.');
        // process.exit(1);
    }

    const notion = new Client({ auth: notionKey });
    let browser;
    // Config based on environment
    const IS_CI = process.env.CI === 'true';
    const USER_DATA_DIR = path.join(__dirname, 'browser_profile');

    try {
        console.log(`🚀 Launching browser (CI: ${IS_CI})...`);

        const launchConfig = {
            headless: IS_CI ? "new" : false, // Headless in CI, Visible Locally
            defaultViewport: null,
            args: ['--start-maximized', '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
        };

        // Only use persistent profile LOCALLY
        if (!IS_CI) {
            launchConfig.userDataDir = USER_DATA_DIR;
        }

        browser = await puppeteer.launch(launchConfig);
        const page = await browser.newPage();

        // 1. Set Realistic User Agent (Avoid HeadlessChrome detection)
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

        await page.setViewport({ width: 1280, height: 800 });
        await page.setExtraHTTPHeaders({
            'Accept-Language': 'en-US,en;q=0.9',
        });

        // Remove navigator.webdriver
        await page.evaluateOnNewDocument(() => {
            Object.defineProperty(navigator, 'webdriver', {
                get: () => false,
            });
        });

        // 1. Session Setup
        if (IS_CI) {
            // CI Mode: Try to load cookies from Env Var
            console.log('☁️ CI Mode detected. Attempting to load FISC_COOKIES...');
            if (process.env.FISC_COOKIES) {
                try {
                    const cookies = JSON.parse(process.env.FISC_COOKIES);
                    await page.setCookie(...cookies);
                    console.log(`   Loaded ${cookies.length} session cookies.`);
                } catch (e) {
                    console.error('❌ Error parsing FISC_COOKIES:', e.message);
                }
            }
        }

        // 2. Check Login Status (STRICT Positive Check)
        console.log('🔑 Checking login status...');
        await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });

        // Wait a small moment for redirects or WAF
        await new Promise(r => setTimeout(r, 3000));

        let loginStatus = await page.evaluate(() => {
            const bodyText = document.body.innerText;
            // Negative check: If we are still on a login form/page
            const hasLoginInput = !!document.querySelector('input[name="email"]');
            const hasLoginBtn = !!document.querySelector('button.g-recaptcha');

            // Positive check: Do we see user menu?
            const hasProfile = bodyText.includes('Tài khoản') || bodyText.includes('Đăng xuất') || bodyText.includes('Account');

            // WAF Check
            const isWAF = document.title.includes('Just a moment') || document.title.includes('Attention Required');

            if (isWAF) return 'WAF';
            if (hasLoginInput || hasLoginBtn) return false;
            if (hasProfile) return true;

            // Ambiguous state (e.g. redirected to home but text weird), default to checking URL
            return !document.location.href.includes('login');
        });

        if (loginStatus === 'WAF') {
            console.error('❌ Blocked by Cloudflare/WAF. Cookies might be IP-locked.');
            if (IS_CI) process.exit(1);
        }

        // ZOMBIE SESSION CHECK:
        // Even if homepage says "LoggedIn", we must verify deep access to reports.
        if (loginStatus === true) {
            console.log('✅ Homepage indicates logged in. Attempting UI Navigation to Reports...');

            // Log LocalStorage
            const localStorageData = await page.evaluate(() => JSON.stringify(window.localStorage));
            console.log('📦 LocalStorage Dump:', localStorageData);

            try {
                const reportLinkFound = await page.evaluate(() => {
                    const links = Array.from(document.querySelectorAll('a'));
                    const target = links.find(a =>
                        a.href.includes('/account/report') ||
                        a.innerText.includes('Báo cáo') ||
                        a.innerText.includes('Phân tích')
                    );
                    if (target) {
                        target.click();
                        return true;
                    }
                    return false;
                });

                if (reportLinkFound) {
                    console.log('🖱️ Clicked "Report" link in UI. Waiting for navigation...');
                    await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 });
                } else {
                    console.log('⚠️ Could not find "Report" link in UI. Falling back to direct URL...');
                    await page.goto(REPORT_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
                }
            } catch (e) {
                console.error('⚠️ UI Navigation failed:', e.message);
                console.log('⚠️ Falling back to direct URL...');
                await page.goto(REPORT_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
            }

            if (page.url().includes('login')) {
                console.warn('⚠️ Report access denied (Redirected to login). Session is invalid/zombie.');
                console.warn(`   Specific URL: ${page.url()}`);

                // Debug Screenshot for Redirect
                const redirectShot = path.join(__dirname, 'redirect_fail.png');
                await page.screenshot({ path: redirectShot });
                console.error(`   📸 Screenshot saved to ${redirectShot} (Artifact)`);

                const redirectHtml = await page.content();
                const redirectHtmlPath = path.join(__dirname, 'redirect_fail.html');
                fs.writeFileSync(redirectHtmlPath, redirectHtml);

                loginStatus = false; // Force re-login
            } else {
                console.log('✅ Report access confirmed.');
                // We are already at REPORT_URL, so we can just stay here or continue logic.
                // Save cookies locally for future CI use
                if (!IS_CI) {
                    const currentCookies = await page.cookies();
                    const cookieFile = path.join(__dirname, 'fisc_cookies_export.json');
                    fs.writeFileSync(cookieFile, JSON.stringify(currentCookies, null, 2));
                    console.log(`💾 Cookies exported to: ${cookieFile}`);
                }
            }
        }

        if (loginStatus === false) {
            console.log('⚠️ Not logged in (or Session Invalid).');

            if (IS_CI) {
                console.log('☁️ CI Mode: Attempting Password Login fallback...');
                // Original CI login failure logic, now a fallback
                if (!email || !password) {
                    console.error('❌ CI Login Failed: FISC_COOKIES invalid or expired, and FISC_EMAIL/FISC_PASSWORD not set.');
                    console.error('   Please run locally, get fisc_cookies_export.json, and update the GitHub Secret.');
                    process.exit(1);
                }

                // CRITICAL FIX: Clear old/bad cookies before fresh login to avoid conflicts
                console.log('🧹 Clearing old cookies to ensure fresh session...');
                const client = await page.target().createCDPSession();
                await client.send('Network.clearBrowserCookies');
                await client.send('Network.clearBrowserCache');

                console.log('Attempting login with provided credentials...');

                // Ensure we are on login page
                if (!page.url().includes('login')) {
                    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' });
                }

                await page.type('input[name="email"]', email);
                await page.type('input[name="password"]', password);

                // Click "Remember Me" if available
                try {
                    const rememberLabel = await page.$('label[for="account"]');
                    if (rememberLabel) await rememberLabel.click();
                } catch (e) { }

                await page.click('button.g-recaptcha');
                await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 });

                const loginResult = await page.evaluate(() => {
                    const url = window.location.href;
                    // 1. URL Check (Most reliable)
                    if (url.includes('/account/') && !url.includes('login')) {
                        return { success: true, reason: 'URL_MATCH', url };
                    }

                    const bodyText = document.body.innerText;
                    const hasLoginInput = !!document.querySelector('input[name="email"]');
                    const hasLoginBtn = !!document.querySelector('button.g-recaptcha');
                    const hasProfile = bodyText.includes('Tài khoản') || bodyText.includes('Đăng xuất') || bodyText.includes('Account');

                    const success = hasProfile && !(hasLoginInput || hasLoginBtn);
                    return {
                        success,
                        reason: success ? 'TEXT_MATCH' : 'TEXT_FAIL',
                        details: { hasProfile, hasLoginInput, hasLoginBtn, url }
                    };
                });

                console.log(`🔍 DEBUG: Login Check Result:`, JSON.stringify(loginResult, null, 2));

                if (loginResult.success) {
                    console.log('✅ CI Login with credentials successful.');
                    console.log('⏳ Waiting 5s for session cookies to settle...');
                    await new Promise(r => setTimeout(r, 5000));

                    // DEBUG: Inspect Session State
                    const cookies = await page.cookies();
                    console.log(`🍪 Cookies found: ${cookies.length}`);
                    cookies.forEach(c => console.log(`   - ${c.name}: ${c.domain} (Expires: ${c.expires})`));

                    // Set Referer to mock real user navigation
                    await page.setExtraHTTPHeaders({
                        'Referer': 'https://fisc.vn/account/community'
                    });

                    // Save cookies only if local (CI doesn't need to save to disk usually, but good for debug)
                    if (!IS_CI) {
                        const currentCookies = await page.cookies();
                        const cookieFile = path.join(__dirname, 'fisc_cookies_export.json');
                        fs.writeFileSync(cookieFile, JSON.stringify(currentCookies, null, 2));
                        console.log(`💾 Cookies exported to: ${cookieFile}`);
                    }
                } else {
                    console.error('❌ CI Login with credentials failed.');
                    console.error('   Page Title:', await page.title());
                    console.error('   Current URL:', page.url());

                    // Capture debug info
                    const screenshotPath = path.join(__dirname, 'login_fail.png');
                    await page.screenshot({ path: screenshotPath });
                    console.error(`   📸 Screenshot saved to ${screenshotPath} (Artifact)`);

                    const htmlContent = await page.content();
                    const htmlPath = path.join(__dirname, 'login_fail.html');
                    fs.writeFileSync(htmlPath, htmlContent);
                    console.error(`   📄 HTML Dump saved to ${htmlPath}`);

                    console.error('   Please check FISC_EMAIL/FISC_PASSWORD or update FISC_COOKIES.');
                    process.exit(1);
                }

            } else {
                console.log('👉 ACTION REQUIRED: Please log in manually in the browser window NOW.');
                // Wait for login success signal (URL change or button disappearance)
                try {
                    await page.waitForFunction(() => {
                        return !document.querySelector('button.g-recaptcha') &&
                            !Array.from(document.querySelectorAll('a')).some(a => a.innerText.includes('Đăng nhập'));
                    }, { timeout: 300000 }); // 5 minutes
                    console.log('✅ Manual login detected!');

                    // Save cookies after manual login
                    const currentCookies = await page.cookies();
                    const cookieFile = path.join(__dirname, 'fisc_cookies_export.json');
                    fs.writeFileSync(cookieFile, JSON.stringify(currentCookies, null, 2));
                    console.log(`💾 Cookies exported to: ${cookieFile}`);
                    console.log('👉 Copy content of fisc_cookies_export.json to GitHub Secret FISC_COOKIES for CI.');

                    // Stop here since we just logged in manually
                    console.log('🔍 Navigating to reports...');
                    await page.goto(REPORT_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
                    // return; // Don't return, flow continues below

                } catch (e) {
                    console.error('❌ Login timeout. Exiting.');
                    process.exit(1);
                }
            }
        }

        // Ensure we are at report URL (if we logged in via credentials, we might be at home)
        if (!page.url().includes('report')) {
            console.log('🔍 Navigating to reports (via UI Click)...');
            try {
                // Save 'Community' page state for debugging
                const commHtml = await page.content();
                fs.writeFileSync(path.join(__dirname, 'community_page.html'), commHtml);

                const reportLinkFound = await page.evaluate(() => {
                    const links = Array.from(document.querySelectorAll('a'));
                    const target = links.find(a =>
                        a.href.includes('/account/report') ||
                        a.innerText.includes('Báo cáo') ||
                        a.innerText.includes('Phân tích')
                    );
                    if (target) {
                        return { found: true, text: target.innerText, href: target.href };
                    }
                    return { found: false };
                });

                if (reportLinkFound.found) {
                    console.log(`🖱️ Found target link: "${reportLinkFound.text}" (${reportLinkFound.href}). Clicking...`);

                    // REFRESH STATE: Ensure cookies and headers are active for this navigation
                    const cookies = await page.cookies();
                    await page.setCookie(...cookies);
                    await page.setExtraHTTPHeaders({ 'Referer': page.url() });

                    // Re-find and click
                    await page.evaluate((href) => {
                        const links = Array.from(document.querySelectorAll('a'));
                        const target = links.find(a => a.href === href);
                        if (target) target.click();
                    }, reportLinkFound.href);

                    await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 });
                } else {
                    console.log('⚠️ Could not find "Report" link. Fallback to direct URL...');
                    await page.goto(REPORT_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
                }
            } catch (e) {
                console.log('⚠️ UI Navigation failed:', e.message);
                console.log('Falling back to direct URL...');
                await page.goto(REPORT_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
            }
        }

        console.log(`📍 Current URL: ${page.url()}`);
        if (page.url().includes('login')) {
            console.error('❌ Error: Login failed (Redirected to login page).');
            console.warn(`   Specific URL: ${page.url()}`);

            // Debug Screenshot
            const failShot = path.join(__dirname, 'final_fail.png');
            await page.screenshot({ path: failShot });
            console.error(`   📸 Screenshot saved to ${failShot} (Artifact)`);

            const failHtml = path.join(__dirname, 'final_fail.html');
            fs.writeFileSync(failHtml, await page.content());

            process.exit(1);
        }

        try {
            await page.waitForSelector('table tbody tr', { timeout: 15000 });
        } catch (e) {
            console.error('⚠️ Timeout waiting for table rows (Page structure might be different).');
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
                    if (link && !link.startsWith('http')) link = `https://fisc.vn${link}`;
                    data.push({ date, title, source, stockCode, link });
                }
            });
            return data;
        });

        console.log(`✅ Found ${reports.length} reports.`);

        // 4. Notion Sync
        const today = new Date().toLocaleDateString('en-GB', { timeZone: 'Asia/Ho_Chi_Minh' });
        console.log(`📅 Today: ${today}`);
        const todaysReports = reports.filter(r => r.date === today);
        console.log(`🎯 Today's reports: ${todaysReports.length}`);

        if (todaysReports.length > 0) {
            console.log('🔄 Syncing with Notion...');
            const existingPages = await notion.databases.query({
                database_id: notionDbId,
                page_size: 100,
                sorts: [{ timestamp: 'created_time', direction: 'descending' }],
            });
            const existingLinks = new Set();
            existingPages.results.forEach(page => {
                if (page.properties.Link?.url) existingLinks.add(page.properties.Link.url);
            });

            for (const report of todaysReports) {
                if (existingLinks.has(report.link)) {
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
                        "Name": { rich_text: [{ text: { content: report.stockCode || "" } }] },
                        "AI Summary": { rich_text: [{ text: { content: "FinSuccess Report - Direct Download" } }] }
                    }
                });
            }
        } else {
            console.log("No reports for today found.");
        }

    } catch (error) {
        console.error('❌ Error:', error.message);
        process.exit(1);
    } finally {
        if (browser) await browser.close();
    }
}

fetchReportLinks();

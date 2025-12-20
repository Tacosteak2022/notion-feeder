const fs = require('fs');
const path = require('path');
// Use puppeteer-extra with stealth plugin to bypass bot detection (headless detection)
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const { Client } = require("@notionhq/client");
require('dotenv').config();

// CONFIG
const LOGIN_URL = 'https://fisc.vn/account/login';
const REPORT_URL = 'https://fisc.vn/account/report';

// HEADLESS MODE CONFIG
// CI usually needs "new" headless mode, invalid session sometimes redirects loops
const IS_CI = process.env.CI === 'true';

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
    }

    if (!notionKey || !notionDbId) {
        console.warn('⚠️ Warning: Notion secrets are missing. Reports will be fetched but NOT synced.');
    }

    const notion = new Client({ auth: notionKey });
    let browser;
    // const IS_CI = process.env.CI === 'true'; // Removed local declaration
    const USER_DATA_DIR = path.join(__dirname, 'browser_profile');

    try {
        console.log(`🚀 Launching browser (CI: ${IS_CI})...`);
        console.log('📦 Version: 3.2 - Geo-Blocking Diagnosis (Proxy + GPS)');

        // CRITICAL: Run HEADFUL (visible) to defeat Bot Detection.
        // In CI, this works because we are using 'xvfb-run' (Virtual Framebuffer).
        /* 
        const launchConfig = {
            headless: false,
            defaultViewport: null,
            args: ['--start-maximized', '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
        }; 
        */

        // Only use persistent profile LOCALLY
        if (!IS_CI) {
            // launchConfig.userDataDir = USER_DATA_DIR; // Temporarily fix scope issue
        }

        // browser = await puppeteer.launch(launchConfig); // Removed premature launch
        // const page = await browser.newPage(); // Removed premature page 

        // 1. Set Realistic User Agent & Client Hints (Fix "Windows UA on Linux" detection)
        const customUA = process.env.FISC_USER_AGENT;
        let userAgentToUse = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

        if (customUA) {
            console.log('🎭 Applying Custom User-Agent to match session...');
            userAgentToUse = customUA;
        }

        const launchConfig = {
            headless: false,
            defaultViewport: null,
            args: [
                '--start-maximized',
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-blink-features=AutomationControlled' // Extra stealth
            ]
        };

        // PROXY CONFIGURATION (For bypassing Geo-Blocking)
        if (process.env.FISC_PROXY) {
            console.log(`🌐 Using Proxy: ${process.env.FISC_PROXY}`);
            launchConfig.args.push(`--proxy-server=${process.env.FISC_PROXY}`);
        }

        browser = await puppeteer.launch(launchConfig);
        const page = await browser.newPage();

        // 2. Deep Spoofing (Identity & Location)
        await page.setUserAgent(userAgentToUse);

        await page.setExtraHTTPHeaders({
            'Accept-Language': 'vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7',
            'Sec-Ch-Ua-Platform': '"Windows"',
            'Sec-Ch-Ua-Mobile': '?0'
        });

        await page.emulateTimezone('Asia/Ho_Chi_Minh');

        // GPS Spoofing (Ho Chi Minh City) - In case they check navigator.geolocation
        // Note: This won't fix IP-based blocking, but it helps consistency.
        await page.setGeolocation({ latitude: 10.762622, longitude: 106.660172 });

        // Network Check (Debug IP)
        try {
            console.log('🌍 Checking Visible IP Address...');
            await page.goto('https://api.ipify.org?format=json', { waitUntil: 'networkidle2', timeout: 15000 });
            const ipInfo = await page.evaluate(() => document.body.innerText);
            console.log(`📍 CI Machine IP: ${ipInfo}`);
        } catch (e) {
            console.warn('⚠️ Could not check IP (Proxy might be slow or blocked):', e.message);
        }

        await page.setViewport({ width: 1280, height: 800 });

        // Remove navigator.webdriver
        await page.evaluateOnNewDocument(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => false });
            Object.defineProperty(navigator, 'platform', { get: () => 'Win32' });
        });

        // 1. Session Setup
        if (IS_CI) {
            // CI Mode: Try to load cookies from Env Var
            console.log('☁️ CI Mode detected. Attempting to load FISC_COOKIES...');
            if (process.env.FISC_COOKIES) {
                try {
                    let validCookies = [];
                    const envCookies = process.env.FISC_COOKIES.trim();

                    if (envCookies.startsWith('[')) {
                        // Case A: JSON Array (from EditThisCookie or similar)
                        const rawCookies = JSON.parse(envCookies);
                        validCookies = rawCookies.map(c => {
                            // Sanitize null domains
                            if (!c.domain) {
                                const { domain, ...rest } = c;
                                return { ...rest, url: 'https://fisc.vn' };
                            }
                            return c;
                        });
                    } else {
                        // Case B: Raw Cookie String (from Network Header)
                        // Format: "name=value; name2=value2"
                        console.log('   Parsing raw cookie string...');
                        validCookies = envCookies.split(';')
                            .map(pair => pair.trim())
                            .filter(pair => pair.length > 0)
                            .map(pair => {
                                const splitIndex = pair.indexOf('=');
                                if (splitIndex === -1) return null;
                                const name = pair.substring(0, splitIndex);
                                const value = pair.substring(splitIndex + 1);
                                return {
                                    name: name,
                                    value: value,
                                    domain: 'fisc.vn',
                                    path: '/',
                                    url: 'https://fisc.vn' // Puppeteer helper
                                };
                            })
                            .filter(c => c !== null);
                    }

                    await page.setCookie(...validCookies);
                    console.log(`   Loaded ${validCookies.length} session cookies.`);
                } catch (e) {
                    console.error('❌ Error loading FISC_COOKIES:', e.message);
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
                // Try to find the Report link in the sidebar or menu
                // Known potential selectors for "Reports" or "Analysis"
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
                    console.log('👉 Copy content of fisc_cookies_export.json to GitHub Secret FISC_COOKIES for CI.');
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

                    // 2. Fallback: Text/Element Check
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
                        console.log('👉 Copy content of fisc_cookies_export.json to GitHub Secret FISC_COOKIES for CI.');
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
            console.log('🔍 Searching for "Báo cáo phân tích" link on current page...');

            // LOGIC: Use human interaction (click) instead of goto to preserve headers/session
            try {
                // XPath for "Báo cáo phân tích" text or href containing "account/report"
                const linkSelector = '//a[contains(text(), "Báo cáo phân tích")] | //a[contains(@href, "account/report")]';
                // Fix: waitForXPath is deprecated in newer Puppeteer. Use waitForFunction.
                await page.waitForFunction((xpath) => {
                    const result = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
                    return result.singleNodeValue !== null;
                }, { timeout: 5000 }, linkSelector);

                const clicked = await page.evaluate((xpath) => {
                    const result = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
                    const node = result.singleNodeValue;
                    if (node) {
                        node.click();
                        return true;
                    }
                    return false;
                }, linkSelector);

                if (clicked) {
                    console.log('👆 Link found! Clicked element inside page.');
                    await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 });
                } else {
                    console.warn('⚠️ Link NOT found. Falling back to direct navigation...');
                    await page.goto(REPORT_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
                }

            } catch (e) {
                console.log('⚠️ Click navigation failed:', e.message);
                console.log('   Falling back to direct goto...');
                await page.goto(REPORT_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
            }
        }

        console.log(`📍 Current URL: ${page.url()}`);
        if (page.url().includes('login')) {
            console.error('❌ Error: Login failed (Redirected to login page).');
            console.warn(`   Specific URL: ${page.url()}`);

            // Log failure page text
            try {
                const failText = await page.evaluate(() => document.body.innerText.substring(0, 1000).replace(/\n/g, ' '));
                console.log(`📄 Failure Page Text: ${failText}`);
            } catch (e) { }

            // Debug Screenshot
            const failShot = path.join(__dirname, 'final_fail.png');
            await page.screenshot({ path: failShot });
            console.error(`   📸 Screenshot saved to ${failShot} (Artifact)`);

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

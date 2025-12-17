const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const LOGIN_URL = 'https://fisc.vn/account/login';
const COOKIE_FILE = path.join(__dirname, 'fisc_cookies.json');

const USER_DATA_DIR = path.join(__dirname, 'browser_profile');

async function setupCookies() {
    console.log('🚀 Launching browser for Fisc login (Persistent Profile)...');
    const browser = await puppeteer.launch({
        headless: false,
        defaultViewport: null,
        userDataDir: USER_DATA_DIR,
        args: ['--start-maximized', '--no-sandbox', '--disable-setuid-sandbox']
    });

    const pages = await browser.pages();
    const page = pages.length > 0 ? pages[0] : await browser.newPage();

    // Set consistent User-Agent
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    // Stealth
    await page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => false });
    });

    try {
        await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' });

        console.log('👉 ACTION REQUIRED: Log in securely to Fisc.vn in the browser window.');
        console.log('   I will check for success every 2 seconds...');

        let attempts = 0;
        const maxAttempts = 150; // 5 minutes

        while (attempts < maxAttempts) {
            await new Promise(r => setTimeout(r, 2000));
            attempts++;

            if (browser.isConnected() === false) {
                console.log('❌ Browser was closed manually.');
                break;
            }

            try {
                // Check if logged in.
                // Logic: "Đăng nhập" text gone, or "Tài khoản" present, or cookies found.
                // Also check URL not being login.
                const url = page.url();
                const content = await page.content();
                const cookies = await page.cookies();

                const onLoginPage = url.includes('login') || content.includes('Sign in') || content.includes('Đăng nhập');
                const hasSessionCookie = cookies.some(c => c.name === 'cms_session');
                // Note: User showed cms_session before but it wasn't enough? 
                // Maybe need to wait for redirect to dashboard/home.

                // Better check: look for user menu or absence of login form
                const hasLoginButton = await page.evaluate(() => {
                    return !!document.querySelector('button.g-recaptcha') ||
                        Array.from(document.querySelectorAll('a')).some(a => a.innerText.includes('Đăng nhập'));
                });

                if (!hasLoginButton && !url.includes('login')) {
                    console.log('✅ Login detected! (Login button gone + URL changed)');

                    const fiscCookies = cookies.filter(c => c.domain.includes('fisc.vn'));
                    fs.writeFileSync(COOKIE_FILE, JSON.stringify(fiscCookies, null, 2));
                    console.log(`💾 Cookies saved to ${COOKIE_FILE}`);

                    console.log('👋 Closing browser in 3 seconds...');
                    await new Promise(r => setTimeout(r, 3000));
                    await browser.close();
                    return;
                }

                if (attempts % 5 === 0) process.stdout.write('.');

            } catch (err) {
                // Ignore transient errors
            }
        }

        console.log('\n❌ Timeout waiting for login.');
        await browser.close();

    } catch (e) {
        console.error('❌ Script Error:', e.message);
    }
}

setupCookies();

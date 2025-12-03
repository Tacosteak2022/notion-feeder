const puppeteer = require('puppeteer');

(async () => {
    const browser = await puppeteer.launch({
        headless: "new",
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });

    const email = process.env.FISC_EMAIL;
    const password = process.env.FISC_PASSWORD;

    console.log('Navigating to FinSuccess login...');
    await page.goto('https://fisc.vn/account/login', { waitUntil: 'networkidle0' });

    console.log('Typing credentials...');
    await page.type('input[name="email"]', email);
    await page.type('input[name="password"]', password);

    console.log('Clicking login...');
    const submitSelector = 'button.g-recaptcha';
    await page.click(submitSelector);

    console.log('Waiting for navigation...');
    try {
        await page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 15000 });
    } catch (e) {
        console.log('Navigation timeout (might be stuck).');
    }

    console.log(`Current URL: ${page.url()}`);
    console.log('Taking screenshot...');
    await page.screenshot({ path: 'fisc_login_debug.png' });

    await browser.close();
})();

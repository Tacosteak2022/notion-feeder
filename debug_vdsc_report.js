const puppeteer = require('puppeteer');
const fs = require('fs');

(async () => {
    const browser = await puppeteer.launch({
        headless: "new",
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });

    // Load env for credentials (simplified for debug)
    const email = process.env.VDSC_EMAIL || 'nuong.ntm@vdsc.com.vn';
    const password = process.env.VDSC_PASSWORD || 'Rongviet123@';

    console.log('Navigating to VDSC login...');
    await page.goto('https://vdsc.com.vn/dang-nhap', { waitUntil: 'domcontentloaded', timeout: 60000 });

    console.log('Logging in...');
    const loginBtnSelector = '.login-button';
    try {
        await page.waitForSelector(loginBtnSelector, { visible: true, timeout: 5000 });
        await page.type('input[placeholder="Tên đăng nhập"], input[name="username"], input[name="email"]', email);
        await page.type('input[type="password"]', password);

        await page.evaluate((selector) => {
            const btn = document.querySelector(selector);
            if (btn) {
                btn.disabled = false;
                btn.click();
            }
        }, loginBtnSelector);

        await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 });
        console.log('Login submitted.');
    } catch (e) {
        console.error('Login failed:', e.message);
    }

    // Log all network requests
    page.on('request', request => {
        if (request.resourceType() === 'xhr' || request.resourceType() === 'fetch') {
            console.log('API Request:', request.url());
        }
    });

    const targetUrl = 'https://vdsc.com.vn/trung-tam-phan-tich/nhan-dinh-hang-ngay/nhat-ky-chuyen-vien';
    console.log(`Navigating to ${targetUrl}...`);
    await page.goto(targetUrl, { waitUntil: 'networkidle0', timeout: 60000 });

    console.log('Taking screenshot...');
    await page.screenshot({ path: 'vdsc_report_debug.png' });

    console.log('Dumping HTML...');
    const html = await page.content();
    fs.writeFileSync('vdsc_report_debug.html', html);

    await browser.close();
})();

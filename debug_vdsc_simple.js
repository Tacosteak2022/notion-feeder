const puppeteer = require('puppeteer');
const fs = require('fs');

(async () => {
    const browser = await puppeteer.launch({
        headless: "new",
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });

    console.log('Navigating to VDSC login...');
    await page.goto('https://vdsc.com.vn/dang-nhap', { waitUntil: 'domcontentloaded', timeout: 60000 });

    console.log('Taking screenshot...');
    await page.screenshot({ path: 'vdsc_login_debug.png' });

    console.log('Dumping HTML...');
    const html = await page.content();
    fs.writeFileSync('vdsc_login_debug.html', html);

    console.log('Inspecting buttons...');
    const buttons = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('button')).map(b => ({
            text: b.innerText,
            html: b.outerHTML,
            visible: b.offsetParent !== null
        }));
    });
    console.log('Buttons:', JSON.stringify(buttons, null, 2));

    await browser.close();
})();

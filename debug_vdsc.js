const puppeteer = require('puppeteer');
const fs = require('fs');

(async () => {
    const browser = await puppeteer.launch({
        headless: "new",
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });

    const url = 'https://vdsc.com.vn/trung-tam-phan-tich/bao-cao-chien-luoc';
    console.log(`Navigating to ${url}...`);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });

    // Screenshot
    await page.screenshot({ path: 'vdsc_debug.png' });
    console.log('Screenshot saved.');

    // Dump HTML
    const html = await page.content();
    fs.writeFileSync('vdsc_debug.html', html);
    console.log('HTML saved.');

    // Try to find "yellow block" elements
    const items = await page.evaluate(() => {
        // Look for common card-like structures
        const potentialCards = Array.from(document.querySelectorAll('div')).filter(div => {
            const style = window.getComputedStyle(div);
            return style.backgroundColor === 'rgb(255, 255, 0)' || // Yellow?
                div.className.includes('item') ||
                div.className.includes('card') ||
                div.className.includes('block');
        });

        return potentialCards.slice(0, 5).map(div => ({
            class: div.className,
            text: div.innerText.substring(0, 100)
        }));
    });

    console.log('Potential items:', items);

    await browser.close();
})();

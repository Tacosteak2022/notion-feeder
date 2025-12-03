const puppeteer = require('puppeteer');
const fs = require('fs');

(async () => {
    const browser = await puppeteer.launch({
        headless: "new",
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });

    const url = 'https://www.shs.com.vn/trung-tam-phan-tich/MACRO';

    page.on('request', request => {
        if (request.resourceType() === 'xhr' || request.resourceType() === 'fetch') {
            console.log('API Request:', request.url());
        }
    });

    console.log(`Navigating to ${url}...`);
    await page.goto(url, { waitUntil: 'networkidle0' });

    console.log('Taking screenshot of main page...');
    await page.screenshot({ path: 'shs_debug_main.png' });

    const html = await page.content();
    fs.writeFileSync('shs_debug_main.html', html);
    console.log('Saved shs_debug_main.html');

    const text = await page.evaluate(() => document.body.innerText);
    // console.log('--- Page Text ---');
    // console.log(text.substring(0, 2000));

    console.log('--- Finding Selectors ---');
    const selectorInfo = await page.evaluate(() => {
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false);
        let node;
        const results = [];
        while (node = walker.nextNode()) {
            if (node.textContent.includes('Báo Cáo Địa Chính Trị Thế Giới')) {
                const parent = node.parentElement;
                results.push({
                    type: 'Title',
                    tag: parent.tagName,
                    class: parent.className,
                    text: node.textContent.trim(),
                    parentTag: parent.parentElement.tagName,
                    parentClass: parent.parentElement.className
                });
            }
            if (node.textContent.includes('Ngày đăng:')) {
                const parent = node.parentElement;
                results.push({
                    type: 'Date',
                    tag: parent.tagName,
                    class: parent.className,
                    text: node.textContent.trim(),
                    parentTag: parent.parentElement.tagName,
                    parentClass: parent.parentElement.className
                });
            }
        }
        return results;
    });
    console.log(JSON.stringify(selectorInfo, null, 2));


    await browser.close();
})();

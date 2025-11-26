const axios = require('axios');
const { JSDOM } = require('jsdom');
const { URL } = require('url');

async function findFeed(targetUrl) {
    console.log(`Looking for feeds in: ${targetUrl}`);

    try {
        const response = await axios.get(targetUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            },
            timeout: 10000
        });

        const contentType = response.headers['content-type'];
        if (contentType.includes('xml') || response.data.trim().startsWith('<?xml') || response.data.trim().startsWith('<rss')) {
            console.log('✅ Success! This URL is already a direct feed.');
            return;
        }

        const dom = new JSDOM(response.data);
        const doc = dom.window.document;
        const feeds = [];

        // Look for <link rel="alternate" type="application/rss+xml" ...>
        const linkTags = doc.querySelectorAll('link[rel="alternate"][type="application/rss+xml"], link[rel="alternate"][type="application/atom+xml"]');

        linkTags.forEach(tag => {
            const href = tag.getAttribute('href');
            if (href) {
                // Resolve relative URLs
                const fullUrl = new URL(href, targetUrl).href;
                feeds.push({
                    title: tag.getAttribute('title') || 'Unknown Feed',
                    url: fullUrl,
                    type: tag.getAttribute('type')
                });
            }
        });

        // Also look for common patterns if none found
        if (feeds.length === 0) {
            console.log('No explicit feed links found. Checking common paths...');
            const commonPaths = ['/feed', '/rss', '/atom.xml', '/feed.xml'];
            for (const path of commonPaths) {
                try {
                    const checkUrl = new URL(path, targetUrl).href;
                    const checkRes = await axios.head(checkUrl, { timeout: 3000, validateStatus: status => status === 200 });
                    if (checkRes.status === 200) {
                        feeds.push({ title: 'Guessed Feed', url: checkUrl, type: 'guessed' });
                    }
                } catch (e) {
                    // Ignore failures
                }
            }
        }

        if (feeds.length > 0) {
            console.log('\n✅ Found the following feeds:');
            feeds.forEach(f => console.log(`- ${f.title}: ${f.url}`));
        } else {
            console.log('❌ No RSS feeds found on this page.');
        }

    } catch (error) {
        console.error(`Error fetching URL: ${error.message}`);
    }
}

const url = process.argv[2];
if (!url) {
    console.log('Usage: node feed_finder.js <url>');
} else {
    findFeed(url);
}

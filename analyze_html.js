const fs = require('fs');
const path = require('path');

const html = fs.readFileSync('vdsc_report_debug.html', 'utf8');

const syntheticRegex = /class="synthetic"(.*?)class="list-tags"/s;
const syntheticMatch = html.match(syntheticRegex);

if (syntheticMatch) {
    console.log('Found .synthetic block.');
    const content = syntheticMatch[1];
    console.log('--- Content Snippet ---');
    console.log(content.substring(0, 3000));
} else {
    console.log('Could not find .synthetic block.');
}

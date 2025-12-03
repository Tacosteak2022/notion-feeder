const fs = require('fs');

const html = fs.readFileSync('shs_debug_main.html', 'utf8');

console.log('--- HTML Snippet ---');
console.log(html.substring(0, 5000));

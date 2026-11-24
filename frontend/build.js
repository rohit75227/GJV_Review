// Copies src/ to dist/. The page has nothing to bundle; d3 loads from cdnjs.
const fs = require('fs');
const path = require('path');
const src = path.join(__dirname, 'src');
const dist = path.join(__dirname, 'dist');
fs.rmSync(dist, { recursive: true, force: true });
fs.cpSync(src, dist, { recursive: true });
fs.copyFileSync(path.join(__dirname, 'staticwebapp.config.json'), path.join(dist, 'staticwebapp.config.json'));
console.log('Built frontend to', dist);

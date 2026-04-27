const fs = require('fs');
let content = fs.readFileSync('apps/control-console/src/App.vue', 'utf8');

// The main theme is dark, let's normalize confusing colors logic simply
content = content.replace(/color: *#(ffb3a7|cfe8ef|f5d76e|c9d4de|aebdca|f5f7fb|a9b7c6|f5fbff|f3f7fb|fff1f1|c8d8e8)/g, 'color: var(--text-color)');
content = content.replace(/color: *#(8fc4ff|7CFC9A)/g, 'color: var(--accent-color)');
content = content.replace(/color: *#aaa;/g, 'color: var(--text-muted);');
content = content.replace(/color: *#bbb;/g, 'color: var(--text-muted);');
content = content.replace(/color: *#ddd;/g, 'color: var(--text-color);');
content = content.replace(/color: *#888;/g, 'color: var(--text-muted);');
content = content.replace(/color: *#7f8c8d;/g, 'color: var(--text-muted);');

// Update the style block to include variables matching GameStudio style
const cssVars = `
<style scoped>
:root {
  --text-color: #e2e8f0;
  --text-muted: #94a3b8;
  --accent-color: #5eccff;
  --error-color: #ef4444;
  --success-color: #10b981;
}
`;

content = content.replace('<style scoped>', cssVars);

fs.writeFileSync('apps/control-console/src/App.vue', content);
console.log('Successfully patched colors in App.vue');

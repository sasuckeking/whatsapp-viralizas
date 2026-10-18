import fs from 'node:fs';
export const ADMIN_HTML = fs.readFileSync(new URL('./admin.html', import.meta.url), 'utf8');

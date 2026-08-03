// SPDX-License-Identifier: AGPL-3.0-or-later
// OpenPrintHQ Cloud Client — update check (CLI).
// Queries the repo's latest Gitea release and compares with the current version.
//
//   node update-check.mjs <currentVersion>
//
// Exit 0 = up to date, 10 = update available, 1 = check failed.

const REPO_API =
  'https://api.github.com/repos/norjms/openprinthq-cloud-client/releases?per_page=10';
const RELEASES = 'https://github.com/norjms/openprinthq-cloud-client/releases';

const current = (process.argv[2] || '0.0.0').replace(/^v/, '');

try {
  const res = await fetch(REPO_API, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const rel = await res.json();
  const latest = String(rel.tag_name || '').replace(/^v/, '');
  if (latest && latest !== current) {
    console.log(`Update available: ${latest} (you have ${current})`);
    console.log(rel.html_url || RELEASES);
    process.exit(10);
  }
  console.log(`Up to date (v${current}).`);
  process.exit(0);
} catch (e) {
  console.error(`Update check failed: ${e.message}`);
  process.exit(1);
}

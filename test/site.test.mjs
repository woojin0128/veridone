// The website build: every page renders, internal links resolve, and pricing follows store.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT, tmpDir } from './helpers.mjs';

function build(store) {
  const dir = tmpDir('veridone-site-');
  const args = ['site/build.mjs', '--out', path.join(dir, 'out')];
  if (store) { fs.writeFileSync(path.join(dir, 'store.json'), JSON.stringify(store)); args.push('--store', path.join(dir, 'store.json')); }
  const r = spawnSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return { out: path.join(dir, 'out'), log: r.stdout };
}

const read = (out, f) => fs.readFileSync(path.join(out, f), 'utf8');
const PAGES = ['index.html', 'ko/index.html', 'activate.html', 'terms.html', 'privacy.html', 'refunds.html', 'ko/activate.html', 'ko/terms.html', 'ko/privacy.html', 'ko/refunds.html', '404.html'];

test('every page renders with working internal links and assets', () => {
  const { out } = build();
  for (const f of PAGES) {
    const html = read(out, f);
    assert.match(html, /^<!doctype html>/, f);
    assert.doesNotMatch(html, /\$\{(?!\{)|undefined|\[object Object\]|NaN/, `${f} has a template leak`);
    for (const [, href] of html.matchAll(/(?:href|src)="([^"#?]+)(?:[?#][^"]*)?"/g)) {
      if (/^(https?:|mailto:)/.test(href) || !href) continue;
      const target = path.resolve(path.dirname(path.join(out, f)), href);
      const file = fs.existsSync(target) && fs.statSync(target).isDirectory() ? path.join(target, 'index.html') : target;
      assert.ok(fs.existsSync(file), `${f} links to missing ${href}`);
    }
  }
  assert.ok(fs.existsSync(path.join(out, 'assets/og.png')));
  assert.ok(fs.existsSync(path.join(out, '.nojekyll')));
  assert.match(read(out, 'sitemap.xml'), /<loc>https:\/\/[^<]+\/ko\/terms\.html<\/loc>/);
});

test('without a store the pricing says paid plans open soon', () => {
  const { out, log } = build();
  assert.match(log, /not connected/);
  const html = read(out, 'index.html');
  assert.match(html, /Paid plans open soon/);
  assert.doesNotMatch(html, /buy\.polar\.sh/);
  assert.match(read(out, 'ko/index.html'), /유료 플랜은 곧 열립니다/);
});

test('with a store the Buy buttons use its checkout links and prices', () => {
  const store = {
    organizationId: 'org-1', organizationSlug: 'veridone', portalUrl: 'https://polar.sh/veridone/portal', benefits: {},
    products: {
      'pro-monthly': { amount: 900, label: '$9 / month', checkoutUrl: 'https://buy.polar.sh/polar_cl_month', interval: 'month' },
      'pro-yearly': { amount: 7900, label: '$79 / year', checkoutUrl: 'https://buy.polar.sh/polar_cl_year', interval: 'year' },
      'pro-lifetime': { amount: 14900, label: '$149 once', checkoutUrl: 'https://buy.polar.sh/polar_cl_life', interval: 'once' },
      'team-yearly': { amount: 19000, perSeat: true, minSeats: 2, label: '$190 / seat / year', checkoutUrl: 'https://buy.polar.sh/polar_cl_team', interval: 'year' },
    },
  };
  const { out, log } = build(store);
  assert.match(log, /Buy buttons live/);
  const html = read(out, 'index.html');
  for (const id of ['month', 'year', 'life', 'team']) assert.match(html, new RegExp(`href="https://buy\\.polar\\.sh/polar_cl_${id}"`));
  assert.match(html, /Buy Pro yearly, \$79/);
  assert.match(html, /from 2 seats/);
  assert.match(html, /https:\/\/polar\.sh\/veridone\/portal/);
  assert.doesNotMatch(html, /Paid plans open soon/);
  assert.match(read(out, 'ko/index.html'), /Pro 연간 구매 \(\$79\)/);
});

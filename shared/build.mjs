#!/usr/bin/env node
/**
 * Renders both sites from shared/products.json.
 *
 * The rule this file enforces, so you never have to remember it:
 *   - EVERY product appears on byzyb.ai, forever, whatever its status.
 *   - ONLY products with a "pklabs" block appear on pklabs.ca.
 *   - Launching a product = add a "pklabs" block and change "status" to "Live".
 *     Nothing moves. Nothing gets deleted. No URL breaks.
 *
 * Run:  node shared/build.mjs
 */

import { readFileSync, writeFileSync, copyFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const products = JSON.parse(readFileSync(join(ROOT, 'shared/products.json'), 'utf8'));

/* ---------- helpers ---------- */

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// A status dot marks things a visitor can actually use today, or nearly.
const hasDot = (p) => p.status === 'Live' || p.status === 'Near launch';

const indent = (block, spaces) =>
  block.split('\n').map((l) => (l.trim() ? ' '.repeat(spaces) + l : l)).join('\n');

function splice(file, marker, body) {
  const path = join(ROOT, file);
  const src = readFileSync(path, 'utf8');
  const open = `<!-- ${marker}:start -->`;
  const close = `<!-- ${marker}:end -->`;
  const a = src.indexOf(open);
  const b = src.indexOf(close);
  if (a === -1 || b === -1) throw new Error(`${file}: missing ${open} / ${close}`);
  const out = src.slice(0, a + open.length) + '\n' + body + '\n' + src.slice(b);
  if (out !== src) {
    writeFileSync(path, out);
    return true;
  }
  return false;
}

/* ---------- byzyb.ai: the complete portfolio ---------- */

const DOT = '<span class="h-1.5 w-1.5 rounded-full bg-ploy-accent-primary"></span>';

function byzybFeature(p) {
  return `<div>
    <a href="${p.byzybHref}" target="_blank" rel="noreferrer" class="group mt-14 block">
        <article class="grid gap-8 border border-ploy-border-primary/60 bg-ploy-neutral-secondary/40 p-9 transition-colors duration-300 hover:border-ploy-text-primary/30 md:grid-cols-[0.85fr_1.15fr] md:gap-14 md:p-14">
            <div class="flex flex-col gap-5">
                ${p.logo ? `<img src="${p.logo}" alt="${esc(p.name)}" class="product-logo"/>` : ''}
                <div class="flex items-center gap-2.5 font-mono text-[0.7rem] uppercase tracking-[0.16em] text-ploy-text-secondary">${hasDot(p) ? DOT : ''}${p.kind} · ${p.status}</div>
                <h3 class="font-heading text-[clamp(2.5rem,4vw,3.5rem)] font-medium leading-[1] tracking-[-0.01em] text-ploy-text-primary">${esc(p.name)}</h3>
                <span class="inline-flex items-center gap-2 font-mono text-[0.7rem] uppercase tracking-[0.16em] text-ploy-text-primary">Visit<span class="transition-transform duration-300 group-hover:translate-x-1">→</span></span>
            </div>
            <p class="text-[1.05rem] leading-[1.85] text-ploy-text-secondary">${p.blurb}</p>
        </article>
    </a>
</div>`;
}

function byzybCard(p) {
  const article = `<article class="group flex h-full flex-col gap-4 border border-ploy-border-primary/50 bg-ploy-neutral-secondary/30 p-8 transition-colors duration-300 hover:border-ploy-text-primary/30 md:p-10">
${p.logo ? `    <img src="${p.logo}" alt="${esc(p.name)}" class="product-logo"/>\n` : ''}    <div class="flex items-center gap-2.5 font-mono text-[0.7rem] uppercase tracking-[0.16em] text-ploy-text-secondary">${hasDot(p) ? DOT : ''}${p.kind} · ${p.status}</div>
    <h3 class="font-heading text-3xl font-medium tracking-[-0.01em] text-ploy-text-primary">${esc(p.name)}</h3>
    <p class="text-[0.95rem] leading-[1.75] text-ploy-text-secondary">${p.blurb}</p>
${p.byzybHref ? `    <span class="mt-auto inline-flex items-center gap-2 pt-3 font-mono text-[0.7rem] uppercase tracking-[0.16em] text-ploy-text-primary">Visit<span class="transition-transform duration-300 group-hover:translate-x-1">→</span></span>\n` : ''}</article>`;

  const inner = p.byzybHref
    ? `<a href="${p.byzybHref}" target="_blank" rel="noreferrer" class="block h-full">\n${indent(article, 4)}\n</a>`
    : article;

  return `<div>\n${indent(inner, 4)}\n</div>`;
}

function buildByzyb() {
  const feature = products.find((p) => p.layout === 'feature');
  const cards = products.filter((p) => p.layout !== 'feature');
  const body = [
    indent(byzybFeature(feature), 16),
    indent(
      `<div class="mt-8 grid gap-5 md:grid-cols-2 lg:grid-cols-3">\n` +
        cards.map((p) => indent(byzybCard(p), 4)).join('\n') +
        `\n</div>`,
      16
    ),
  ].join('\n\n');
  return splice('byzyb/index.html', 'products', body);
}

/* ---------- pklabs.ca: shipped products only ---------- */

function pkCard(p) {
  return `<a href="products/${p.pklabs.slug}.html" class="block h-full">
    <article class="group flex h-full flex-col gap-4 border border-ploy-border-primary/50 bg-ploy-neutral-secondary/30 p-8 transition-colors duration-300 hover:border-pk-accent/60 md:p-10">
        <div class="flex items-center gap-2.5 font-mono text-[0.7rem] uppercase tracking-[0.16em] text-ploy-text-secondary"><span class="h-1.5 w-1.5 rounded-full bg-pk-accent"></span>${p.kind} · ${p.status}</div>
        <h3 class="font-heading text-3xl font-medium tracking-[-0.01em] text-ploy-text-primary">${esc(p.name)}</h3>
        <p class="text-[1.05rem] leading-[1.7] text-ploy-text-primary">${esc(p.pklabs.tagline)}</p>
        <p class="text-[0.95rem] leading-[1.75] text-ploy-text-secondary">${p.blurb}</p>
        <span class="mt-auto inline-flex items-center gap-2 pt-3 font-mono text-[0.7rem] uppercase tracking-[0.16em] text-pk-accent">Details<span class="transition-transform duration-300 group-hover:translate-x-1">→</span></span>
    </article>
</a>`;
}

function buildPkIndex() {
  const live = products.filter((p) => p.pklabs);
  const body = indent(
    `<div class="mt-14 grid gap-5 md:grid-cols-2 lg:grid-cols-3">\n` +
      live.map((p) => indent(`<div>\n${indent(pkCard(p), 4)}\n</div>`, 4)).join('\n') +
      `\n</div>`,
    16
  );
  return splice('pklabs/index.html', 'products', body);
}

function pkProductPage(p) {
  return `<!DOCTYPE html>
<html lang="en" class="dark" data-theme="dark">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(p.name)} | PainKiller Labs</title>
<meta name="description" content="${esc(p.pklabs.tagline)}">
<link rel="canonical" href="https://pklabs.ca/products/${p.pklabs.slug}.html">
<meta property="og:type" content="product">
<meta property="og:url" content="https://pklabs.ca/products/${p.pklabs.slug}.html">
<meta property="og:title" content="${esc(p.name)} | PainKiller Labs">
<meta property="og:description" content="${esc(p.pklabs.tagline)}">
<meta property="og:image" content="https://pklabs.ca/brand/pklabs-og-image.png">
<meta name="twitter:card" content="summary_large_image">
<link rel="icon" href="../favicons/favicon.ico">
<link rel="icon" type="image/png" sizes="32x32" href="../favicons/favicon-32x32.png">
<link rel="apple-touch-icon" sizes="180x180" href="../favicons/favicon-180x180.png">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,500;0,600;0,700&family=Inter:wght@300;400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<link rel="stylesheet" href="../ploy-styles.css">
<link rel="stylesheet" href="../pklabs-theme.css">
</head>
<body class="bg-ploy-background-primary text-ploy-text-primary antialiased overflow-x-hidden m-0" style="font-family: 'Inter', system-ui, sans-serif">

<!-- header:start -->
<!-- header:end -->

<main class="pt-32 md:pt-40">
    <section class="mx-auto max-w-[62rem] px-6 pb-20 md:px-12 md:pb-28">
        <a href="../index.html#products" class="font-mono text-[0.7rem] uppercase tracking-[0.16em] text-ploy-text-secondary transition-colors hover:text-pk-accent">← All products</a>
        <div class="mt-8 flex items-center gap-2.5 font-mono text-[0.7rem] uppercase tracking-[0.16em] text-ploy-text-secondary"><span class="h-1.5 w-1.5 rounded-full bg-pk-accent"></span>${p.kind} · ${p.status} · ${esc(p.pklabs.platform)}</div>
        <h1 class="mt-5 font-heading text-[clamp(3rem,7vw,5.5rem)] font-medium leading-[1] tracking-[-0.01em] text-ploy-text-primary">${esc(p.name)}</h1>
        <p class="mt-6 max-w-2xl font-heading text-[clamp(1.5rem,3vw,2.25rem)] font-medium leading-[1.25] text-ploy-text-primary">${esc(p.pklabs.tagline)}</p>
        <p class="mt-8 max-w-2xl text-[1.05rem] leading-[1.85] text-ploy-text-secondary">${p.blurb}</p>

        <div class="mt-12 flex flex-wrap items-center gap-4">
            <a href="${p.pklabs.url}" target="_blank" rel="noreferrer" class="rounded-full bg-pk-accent px-7 py-3 font-mono text-[0.72rem] font-semibold uppercase tracking-[0.16em] text-pk-on-accent transition-opacity hover:opacity-90">Open ${esc(p.name)} →</a>
            <a href="../support.html" class="rounded-full border border-ploy-border-primary px-7 py-3 font-mono text-[0.72rem] uppercase tracking-[0.16em] text-ploy-text-secondary transition-colors hover:text-ploy-text-primary">Get support</a>
        </div>

        <dl class="mt-16 grid gap-px overflow-hidden border border-ploy-border-primary/50 bg-ploy-border-primary/50 sm:grid-cols-3">
            <div class="bg-ploy-background-primary p-7">
                <dt class="font-mono text-[0.68rem] uppercase tracking-[0.16em] text-ploy-text-secondary">Platform</dt>
                <dd class="mt-2 text-ploy-text-primary">${esc(p.pklabs.platform)}</dd>
            </div>
            <div class="bg-ploy-background-primary p-7">
                <dt class="font-mono text-[0.68rem] uppercase tracking-[0.16em] text-ploy-text-secondary">Status</dt>
                <dd class="mt-2 text-ploy-text-primary">${p.status}</dd>
            </div>
            <div class="bg-ploy-background-primary p-7">
                <dt class="font-mono text-[0.68rem] uppercase tracking-[0.16em] text-ploy-text-secondary">Published by</dt>
                <dd class="mt-2 text-ploy-text-primary">PainKiller Labs</dd>
            </div>
        </dl>
    </section>
</main>

<!-- footer:start -->
<!-- footer:end -->

</body>
</html>
`;
}

/* ---------- pklabs header + footer, injected into every page ---------- */

function pkHeader(depth) {
  const up = depth ? '../'.repeat(depth) : '';
  return `<header class="fixed inset-x-0 top-0 z-[100] bg-gradient-to-b from-ploy-background-primary via-ploy-background-primary/70 to-transparent">
    <div class="mx-auto flex max-w-[82rem] items-center justify-between px-6 py-5 md:px-12 md:py-6">
        <a href="${up}index.html" class="flex items-center" aria-label="PainKiller Labs">
            <img src="${up}brand/pklabs-horizontal.png" srcset="${up}brand/pklabs-horizontal.png 1x, ${up}brand/pklabs-horizontal@2x.png 2x" alt="PainKiller Labs" class="h-7 w-auto md:h-8"/>
        </a>
        <nav class="hidden items-center gap-9 md:flex">
            <a href="${up}index.html#products" class="font-mono text-[0.7rem] uppercase tracking-[0.18em] text-ploy-text-secondary transition-colors duration-300 hover:text-ploy-text-primary">Products</a>
            <a href="${up}changelog.html" class="font-mono text-[0.7rem] uppercase tracking-[0.18em] text-ploy-text-secondary transition-colors duration-300 hover:text-ploy-text-primary">Changelog</a>
            <a href="${up}about.html" class="font-mono text-[0.7rem] uppercase tracking-[0.18em] text-ploy-text-secondary transition-colors duration-300 hover:text-ploy-text-primary">About</a>
            <a href="${up}support.html" class="font-mono text-[0.7rem] uppercase tracking-[0.18em] text-ploy-text-secondary transition-colors duration-300 hover:text-ploy-text-primary">Support</a>
        </nav>
        <a href="mailto:rh@pklabs.ca" class="rounded-full bg-pk-accent px-5 py-2 font-mono text-[0.7rem] font-semibold uppercase tracking-[0.16em] text-pk-on-accent transition-opacity duration-300 hover:opacity-90">Contact</a>
    </div>
</header>`;
}

function pkFooter(depth) {
  const up = depth ? '../'.repeat(depth) : '';
  return `<footer class="border-t border-ploy-border-primary/60">
    <div class="mx-auto flex max-w-[82rem] flex-col gap-6 px-6 py-12 md:flex-row md:items-center md:justify-between md:px-12">
        <p class="font-mono text-[0.7rem] uppercase tracking-[0.16em] text-ploy-text-secondary">© ${new Date().getFullYear()} PainKiller Labs</p>
        <nav class="flex flex-wrap gap-7">
            <a href="${up}support.html" class="font-mono text-[0.7rem] uppercase tracking-[0.16em] text-ploy-text-secondary transition-colors duration-300 hover:text-ploy-text-primary">Support</a>
            <a href="${up}legal/terms.html" class="font-mono text-[0.7rem] uppercase tracking-[0.16em] text-ploy-text-secondary transition-colors duration-300 hover:text-ploy-text-primary">Terms</a>
            <a href="${up}legal/privacy.html" class="font-mono text-[0.7rem] uppercase tracking-[0.16em] text-ploy-text-secondary transition-colors duration-300 hover:text-ploy-text-primary">Privacy</a>
            <a href="${up}legal/refunds.html" class="font-mono text-[0.7rem] uppercase tracking-[0.16em] text-ploy-text-secondary transition-colors duration-300 hover:text-ploy-text-primary">Refunds</a>
            <a href="https://byzyb.ai" class="font-mono text-[0.7rem] uppercase tracking-[0.16em] text-ploy-text-secondary transition-colors duration-300 hover:text-ploy-text-primary">Founder</a>
        </nav>
    </div>
</footer>`;
}

/* ---------- run ---------- */

const changed = [];

// 1. Shared stylesheet is copied into each site, because Vercel's Root Directory
//    means a site can only serve files that live inside its own folder.
for (const site of ['byzyb', 'pklabs']) {
  copyFileSync(join(ROOT, 'shared/ploy-styles.css'), join(ROOT, site, 'ploy-styles.css'));
}

// 2. Product grids.
if (buildByzyb()) changed.push('byzyb/index.html');
if (buildPkIndex()) changed.push('pklabs/index.html');

// 3. One page per shipped product.
mkdirSync(join(ROOT, 'pklabs/products'), { recursive: true });
for (const p of products.filter((x) => x.pklabs)) {
  const file = `pklabs/products/${p.pklabs.slug}.html`;
  writeFileSync(join(ROOT, file), pkProductPage(p));
  changed.push(file);
}

// 4. Header and footer into every pklabs page.
const pkPages = [];
for (const dir of ['', 'products', 'legal']) {
  const abs = join(ROOT, 'pklabs', dir);
  for (const f of readdirSync(abs, { withFileTypes: true })) {
    if (f.isFile() && f.name.endsWith('.html')) pkPages.push([dir ? `${dir}/${f.name}` : f.name, dir ? 1 : 0]);
  }
}
for (const [rel, depth] of pkPages) {
  const file = `pklabs/${rel}`;
  const a = splice(file, 'header', indent(pkHeader(depth), 0));
  const b = splice(file, 'footer', indent(pkFooter(depth), 0));
  if ((a || b) && !changed.includes(file)) changed.push(file);
}

/* ---------- guard: ploy-styles.css is a COMPILED Tailwind build ----------
   It only contains the classes byzyb.ai uses. A class used on pklabs.ca but
   absent from both stylesheets silently does nothing — which is how you get a
   1000px-wide logo. Warn loudly instead. */

function checkClasses() {
  const css =
    readFileSync(join(ROOT, 'shared/ploy-styles.css'), 'utf8') +
    readFileSync(join(ROOT, 'pklabs/pklabs-theme.css'), 'utf8');
  const escapeClass = (c) => [...c].map((ch) => ('.:/[]()%#,&!'.includes(ch) ? '\\' + ch : ch)).join('');

  const used = new Set();
  for (const [rel] of pkPages) {
    const src = readFileSync(join(ROOT, 'pklabs', rel), 'utf8');
    for (const m of src.matchAll(/class="([^"]+)"/g)) m[1].split(/\s+/).forEach((c) => c && used.add(c));
  }
  // Match at a class-name boundary: '.py-3' must not match inside '.py-32'.
  const present = (c) => {
    const needle = '.' + escapeClass(c);
    let i = -1;
    while ((i = css.indexOf(needle, i + 1)) !== -1) {
      const next = css[i + needle.length];
      if (next === undefined || !/[A-Za-z0-9_\\-]/.test(next)) return true;
    }
    return false;
  };
  const missing = [...used].filter((c) => !present(c)).sort();
  if (missing.length) {
    console.warn(`\n!!  ${missing.length} class(es) used on pklabs.ca have no CSS rule.`);
    console.warn('    Add them to pklabs/pklabs-theme.css:');
    console.warn('      ' + missing.join('\n      ') + '\n');
  }
  return missing.length;
}

const missingCount = checkClasses();

console.log(`Built ${products.length} products (${products.filter((p) => p.pklabs).length} on pklabs.ca).`);
console.log(changed.length ? 'Updated:\n  ' + changed.join('\n  ') : 'No changes.');
if (missingCount) process.exitCode = 1;

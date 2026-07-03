#!/usr/bin/env node
// Command-line interface for the Facebook Ad Library landing-page scraper.
//
// Usage:
//   node src/cli.js --brand "Allbirds" [--country US] [--max 300]
//                   [--group domain|url] [--out results] [--json] [--show-browser]

import { writeFileSync } from 'node:fs';
import { scrapeAdLibrary } from './scraper.js';
import { aggregate, toAdsCsv, toSummaryCsv } from './aggregate.js';

function parseArgs(argv) {
  const args = { country: 'US', max: 300, group: 'domain', headless: true };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '--brand': case '-b': args.brand = next(); break;
      case '--page-id': args.pageId = next(); break;
      case '--country': case '-c': args.country = next(); break;
      case '--max': case '-m': args.max = parseInt(next(), 10); break;
      case '--group': case '-g': args.group = next(); break;
      case '--out': case '-o': args.out = next(); break;
      case '--json': args.json = true; break;
      case '--show-browser': args.headless = false; break;
      case '--help': case '-h': args.help = true; break;
      default:
        if (!a.startsWith('-') && !args.brand) args.brand = a;
    }
  }
  return args;
}

const HELP = `
Facebook Ad Library → Landing Pages

Scrapes a brand on the Facebook Ad Library and lists the websites linked from
its ads, how many ads point to each, plus a preview link for every ad.

Usage:
  node src/cli.js --brand "Brand Name" [options]

Options:
  -b, --brand <name>     Brand / keyword to search (required unless --page-id)
      --page-id <id>     Search a specific Facebook Page id instead of a keyword
  -c, --country <code>   2-letter country code (default: US)
  -m, --max <n>          Max ads to collect (default: 300)
  -g, --group <mode>     Group results by "domain" (default) or "url"
  -o, --out <basename>   Write <basename>-summary.csv, -ads.csv, .json
      --json             Print full JSON to stdout instead of a table
      --show-browser     Run with a visible browser (debugging)
  -h, --help             Show this help

Examples:
  node src/cli.js --brand "Allbirds" --country US --max 200
  node src/cli.js --brand "Ridge Wallet" --group url --out ridge
`;

function pad(s, n) {
  s = String(s);
  return s.length > n ? s.slice(0, n - 1) + '…' : s.padEnd(n);
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help || (!args.brand && !args.pageId)) {
    console.log(HELP);
    process.exit(args.help ? 0 : 1);
  }

  console.error(`\nSearching Facebook Ad Library for "${args.brand || args.pageId}" (${args.country})…\n`);

  const { ads, searchUrl } = await scrapeAdLibrary({
    brand: args.brand,
    pageId: args.pageId,
    country: args.country,
    maxAds: args.max,
    headless: args.headless,
    onProgress: (msg, data) =>
      console.error(`  · ${msg}${data?.count != null ? `: ${data.count}` : ''}`),
  });

  const summary = aggregate(ads, args.group === 'url' ? 'url' : 'domain');

  if (args.json) {
    console.log(JSON.stringify({ searchUrl, ...summary }, null, 2));
  } else {
    console.error(`\nSearch URL: ${searchUrl}`);
    console.error(`Total ads: ${summary.totalAds}   Unique ${summary.groupBy}s: ${summary.uniqueGroups}\n`);
    console.log(`${pad('#', 5)}${pad('ADS', 6)}${pad('WEBSITE', 45)}PREVIEW (first ad)`);
    console.log('-'.repeat(100));
    summary.groups.forEach((g, i) => {
      console.log(
        `${pad(i + 1, 5)}${pad(g.adCount, 6)}${pad(g.website || '(none)', 45)}${g.previewUrls[0] || ''}`,
      );
    });
    console.log('');
  }

  if (args.out) {
    writeFileSync(`${args.out}-summary.csv`, toSummaryCsv(summary));
    writeFileSync(`${args.out}-ads.csv`, toAdsCsv(ads));
    writeFileSync(`${args.out}.json`, JSON.stringify({ searchUrl, ...summary }, null, 2));
    console.error(`Saved: ${args.out}-summary.csv, ${args.out}-ads.csv, ${args.out}.json\n`);
  }
}

main().catch((err) => {
  console.error('\nError:', err.message);
  process.exit(1);
});

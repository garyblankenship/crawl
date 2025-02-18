#!/usr/bin/env -S bun run

import { chromium } from "playwright";
import fs from "fs/promises";
import path from "path";
import { URL } from "url";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";

const CACHE_FILE = "./tmp/crawl_cache.txt";
const OUTPUT_DIR = "./tmp";
const CRAWLER_IGNORE_FILE = ".crawlerignore";

await fs.mkdir(OUTPUT_DIR, { recursive: true });

async function loadCache() {
    try {
        const data = await fs.readFile(CACHE_FILE, "utf-8");
        return new Set(data.split(/\s+/).filter(Boolean));
    } catch (error) {
        if (error.code === "ENOENT") {
            return new Set();
        }
        throw error;
    }
}

async function saveCache(visited) {
    const data = [...visited].join("\n");
    await fs.writeFile(CACHE_FILE, data, "utf-8");
}

function getFilePath(url) {
    const parsedUrl = new URL(url);
    const pathParts = parsedUrl.pathname.split("/").filter(Boolean);
    let filename = pathParts.pop() || "index.html";
    if (!filename.includes(".")) {
        filename += ".html";
    }
    return path.join(OUTPUT_DIR, parsedUrl.hostname, ...pathParts, filename);
}

function wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function loadExclusionPatterns() {
    try {
        const data = await fs.readFile(CRAWLER_IGNORE_FILE, "utf-8");
        return data.split("\n")
            .map(line => line.trim())
            .filter(line => line !== "" && !line.startsWith("#"));
    } catch (error) {
        if (error.code === "ENOENT") {
            return [];
        }
        throw error;
    }
}

function shouldExclude(url, patterns) {
    for (const pattern of patterns) {
        if (url.includes(pattern)) {
            return true;
        }
    }
    return false;
}

async function crawlPage(page, url, baseUrl, exclusionPatterns) {
    console.log(`Crawling: ${url}`);

    try {
        const response = await page.goto(url, { waitUntil: "networkidle" });
        if (!response) {
            console.log(`  Failed to load (null response): ${url}`);
            return [];
        }

        const status = response.status();
        if (status >= 400) {
            console.log(`  Failed to load (status ${status}): ${url}`);
            return [];
        }

        const filePath = getFilePath(url);
        const dirPath = path.dirname(filePath);
        await fs.mkdir(dirPath, { recursive: true });

        const htmlContent = await page.content();
        await fs.writeFile(filePath, htmlContent, "utf-8");

        const links = await page.locator("a").evaluateAll(nodes => nodes.map(n => n.href));
        const baseUrlObj = new URL(baseUrl);
        const newLinks = [];

        for (const link of links) {
            try {
                const absoluteLink = new URL(link, url);
                if (absoluteLink.hostname === baseUrlObj.hostname) {
                    newLinks.push(absoluteLink.toString());
                }
            } catch (linkError) {
                console.error(`  Error processing link ${link}:`, linkError);
            }
        }
        return newLinks;

    } catch (error) {
        console.error(`  Error crawling ${url}:`, error);
        return [];
    }
}
async function main(startUrl, force, depth, delay) {
    const browser = await chromium.launch();
    const page = await browser.newPage();

    await page.route("**/*", (route) => {
        return /image|stylesheet|font/.test(route.request().resourceType())
            ? route.abort()
            : route.continue();
    });

    const visited = await loadCache();
    const exclusionPatterns = await loadExclusionPatterns();

    if (force) {
        visited.delete(startUrl);
    }

    const queue = [{ url: startUrl, depth: 0 }];

    while (queue.length > 0) {
        const { url: currentUrl, depth: currentDepth } = queue.shift();

        if (visited.has(currentUrl) || shouldExclude(currentUrl, exclusionPatterns)) {
            console.log(`Skipping: ${currentUrl}`);
            continue;
        }

        visited.add(currentUrl);
        await wait(delay * 1000);
        const newLinks = await crawlPage(page, currentUrl, startUrl, exclusionPatterns);

        if (currentDepth < depth) {
            for (const link of newLinks) {
                if (!visited.has(link) && !shouldExclude(link, exclusionPatterns)) {
                    queue.push({ url: link, depth: currentDepth + 1 });
                }
            }
        }
    }

    await browser.close();
    await saveCache(visited);
}

const argv = yargs(hideBin(process.argv))
    .scriptName("crawl")
    .usage("Usage: $0 <start_url> [-f] [-d <depth>] [--delay <seconds>]")
    .option("f", {
        alias: "force",
        describe: "Force re-crawl of the start URL",
        type: "boolean",
        default: false,
    })
    .option("d", {
        alias: "depth",
        describe: "Maximum crawl depth",
        type: "number",
        default: 2,
    })
    .option("delay", {
        describe: "Delay between requests in seconds",
        type: "number",
        default: 0,
    })
    .demandCommand(1, "You must provide a start URL")
    .parse();

const startUrl = argv._[0];
const force = argv.force;
const depth = argv.depth;
const delay = argv.delay;

main(startUrl, force, depth, delay);
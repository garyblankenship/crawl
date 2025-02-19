#!/usr/bin/env -S bun run

import { chromium } from "playwright";
import fs from "fs/promises";
import path from "path";
import { URL } from "url";
import yaml from "js-yaml";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";

const CACHE_FILE = "./tmp/crawl_cache.txt";
const OUTPUT_DIR = "./tmp";
const CRAWLER_IGNORE_FILE = ".crawlerignore";
const CRAWL_CONFIG_FILE = "crawl.yml";

await fs.mkdir(OUTPUT_DIR, { recursive: true });

let VERBOSE = false;

function logInfo(...args) {
    if (!VERBOSE && !args[0].startsWith("Received response")) return;
    console.log(`${new Date().toISOString()} [INFO]`, ...args);
}

async function loadCache() {
    try {
        const data = await fs.readFile(CACHE_FILE, "utf-8");
        return new Set(data.split(/\s+/).filter(Boolean));
    } catch (error) {
        logInfo("Error loading cache:", error.message);
        return new Set(); // Maintain default behavior but with improved logging.
    }
}

async function saveCache(visited) {
    const data = [...visited].join("\n");
    await fs.writeFile(CACHE_FILE, data, "utf-8");
}

function getFilePath(url) {
    const parsedUrl = new URL(url);
    let pathname = parsedUrl.pathname;

    const knownExtensions = new Set(['.html', '.htm', '.pdf', '.xml', '.json', '.js', '.css']);
    const ext = path.extname(pathname);
    if (pathname.endsWith("/")) {
      pathname += "index.html";
    } else if (!ext || !knownExtensions.has(ext.toLowerCase())) {
      // If the pathname does not end with a slash and the extension is not one of the known file types,
      // assume it is a directory and append '/index.html'
      pathname += "/index.html";
    }

    const filename = path.basename(pathname);
    const dirPath = path.join(OUTPUT_DIR, parsedUrl.hostname, path.dirname(pathname));
    const filePath = path.join(dirPath, filename);
    // logInfo(`Generated file path: ${filePath}`);
    return filePath;
}

function wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// New helper function for exponential backoff
function exponentialBackoff(retries) {
  const baseDelay = 1000;
  const jitter = Math.random() * 500;
  const delay = baseDelay * 2 ** retries + jitter;
  logInfo(`Waiting ${delay / 1000} seconds before retrying...`);
  return wait(delay);
}

async function crawlPdf(page, url) {
    logInfo(`Crawling PDF: ${url}`);
    const filePath = getFilePath(url);
    await downloadPdf(url, filePath, page.context());
    return [];  // PDFs do not generate further links.
}

async function downloadPdf(url, filePath, context) {
    logInfo(`Downloading PDF via request API: ${url}`);
    
    // Check if the file already exists to avoid redundant downloads.
    try {
        await fs.access(filePath);
        logInfo(`File already exists, skipping download: ${filePath}`);
        return;
    } catch (err) {
        // File does not exist; proceed with download.
    }
    
    const response = await context.request.get(url);
    if (!response.ok()) {
        throw new Error(`Failed to download PDF: ${url} (status ${response.status()})`);
    }
    const buffer = await response.body();
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, buffer);
    const size = buffer.length;
    logInfo(`PDF successfully saved at: ${filePath} (${size} bytes)`);
}

async function handleContentType(page, response, url) {
    const filePath = getFilePath(url);
    if (url.toLowerCase().includes("api.github.com/repos/")) {
        return await handleGitHubApiContent(response, filePath);
    } else {
        return await handleHtmlContent(page, response, filePath);
    }
}


async function retryWithBackoff(fn, maxRetries) {
  for (let retries = 0; retries <= maxRetries; retries++) {
    try {
      return await fn();
    } catch (error) {
      logInfo(`Error on retry ${retries + 1}: ${error.message}.`);
      if (retries < maxRetries) {
        await exponentialBackoff(retries);
      }
    }
  }
  logInfo("Max retries reached.");
  throw new Error("Failed after maximum retries");
}

async function navigateToPage(page, url) {
  try {
    return await page.goto(url, { waitUntil: "load" });
  } catch (error) {
    logInfo(`Navigation failed for ${url}: ${error.message}`);
    throw error;
  }
}

async function loadPatternsFromFile(filePath) {
    try {
        if (filePath.endsWith(".yml")) {
            const config = yaml.load(await fs.readFile(filePath, "utf8"));
            return config.ignorePatterns || []; // Return empty array
        } else {
            const data = await fs.readFile(filePath, "utf-8");
            return data.split("\n")
                .map(line => line.trim())
                .filter(line => line !== "" && !line.startsWith("#"));
        }
    } catch (error) {
        // Simplified: We're not handling errors in this round.
        return [];
    }
}

function isPdfUrl(url) {
  return url.toLowerCase().endsWith(".pdf");
}

function isGitHubApiUrl(url) {
  return url.toLowerCase().includes("api.github.com/repos/");
}

async function handlePdfDownload(response, filePath) {
  const contentType = response.headers()['content-type'] || "(no content-type)";
  logInfo(`Handling PDF: URL=${response.url()} | Content-Type=${contentType}`);
  try {
      await downloadFile(response, filePath);
      logInfo(`PDF successfully saved at: ${filePath}`);
  } catch (error) {
      console.error(`Failed to save PDF at ${filePath}:`, error);
  }
  return [];
}

async function handleHtmlContent(page, response, filePath) {
  const htmlContent = await response.text();
  await fs.writeFile(filePath, htmlContent, "utf-8");
  logInfo(`Saved HTML content: ${filePath}`);
  return await extractLinksFromHtml(page, htmlContent, response.url());
}

async function loadExclusionPatterns(configFile) {
    const crawlerIgnorePatterns = await loadPatternsFromFile(CRAWLER_IGNORE_FILE);
    const configFilePatterns = await loadPatternsFromFile(configFile);
    return [...crawlerIgnorePatterns, ...configFilePatterns];
}

function shouldExclude(url, patterns) {
    try {
        const parsedUrl = new URL(url);
        return patterns.some(pattern => parsedUrl.pathname.includes(pattern));
    } catch (error) {
        console.error(`Error in shouldExclude for URL ${url}:`, error);
        return false;
    }
}

function normalizeUrl(url) {
    try {
        const parsedUrl = new URL(url);
        // Remove trailing slash from the pathname
        const pathname = parsedUrl.pathname.replace(/\/$/, '');
        // Exclude query string and hash from the normalized URL
        const normalizedUrl = parsedUrl.origin + pathname + parsedUrl.search;
        logInfo(`Normalized URL: ${url} -> ${normalizedUrl}`);
        return normalizedUrl;
    } catch (error) {
        console.error(`Error normalizing URL ${url}:`, error);
        return url;
    }
}

async function downloadFile(response, filePath) {
    const buffer = await response.body();
    try {
        await fs.writeFile(filePath, buffer);
        logInfo(`Saved file (${buffer.length} bytes): ${filePath}`);
    } catch (error) {
        console.error(`Error writing file at ${filePath}:`, error);
        throw error;
    }
}

async function handleGitHubApiContent(response, filePath) {
    const jsonData = await response.json();
    const jsonString = JSON.stringify(jsonData, null, 2);
    await fs.writeFile(filePath, jsonString, "utf-8");
    logInfo(`Saved GitHub API content: ${filePath}`);
    logInfo("Processed GitHub API repo content.");

    let extractedLinks = [];
    if (Array.isArray(jsonData)) {
        for (const item of jsonData) {
            if (item) {
                if (item.html_url) {
                    extractedLinks.push(item.html_url);
                }
                if (item.type === "file" && item.download_url) {
                    extractedLinks.push(item.download_url);
                }
            }
        }
    }
    logInfo("Extracted GitHub links:", extractedLinks);
    return extractedLinks;
}

async function extractLinksFromHtml(page, htmlContent, finalUrl) {
    let newLinks = [];
    const baseUrlObj = new URL(finalUrl); // Use finalUrl as base for relative links

    if (htmlContent.includes("<title>Index of") && htmlContent.includes("<table>")) {
        const regex = /<a href="([^"]*)"/g;
        let match;
        while ((match = regex.exec(htmlContent)) !== null) {
            const link = match[1];
            if (link) {
                try {
                    const absoluteLink = new URL(link, finalUrl);
                    newLinks.push(absoluteLink.toString());
                } catch (error) {
                    console.error(`  Skipping invalid URL in Apache listing: ${link}`);
                }
            }
        }
    } else {
        newLinks = await page.locator("a").evaluateAll(nodes => nodes.map(n => n.href));
    }

    logInfo(`Raw extracted links count: ${newLinks.length}`);
    
    const filteredLinks = [];
    let externalCount = 0;
    for (const link of newLinks) {
        let absolute;
        try {
            absolute = new URL(link, finalUrl);
            if (absolute.hostname !== baseUrlObj.hostname) {
                logInfo(`Found external link (skipped): ${absolute.toString()}`);
                externalCount++;
                continue;
            }
        } catch (error) {
            console.error(`Skipping invalid URL (hostname check): ${link}`);
            continue;
        }
    
        try {
            const normalized = normalizeUrl(absolute.toString());
            filteredLinks.push(normalized);
        } catch (error) {
            console.error(`Skipping invalid URL: ${link}`);
        }
    }
    logInfo(`Skipped ${externalCount} external links; kept ${filteredLinks.length} internal links.`);
    if (filteredLinks.length > 0) {
        logInfo('Extracted internal links:', filteredLinks);
    } else {
        logInfo('No internal links extracted.');
    }
    return filteredLinks;
}


async function crawlPage(page, url, baseUrl, exclusionPatterns, maxRetries) {
    logInfo(`Crawling: ${url}`);
    if (isPdfUrl(url)) {
        return await crawlPdf(page, url);
    }
    try {
         let response;
         response = await page.goto(url, { waitUntil: "load" });
         
         if (!response) {
             logInfo(`Failed to load (null response): ${url}`);
             throw new Error(`Null response from ${url}`);
         }
         
         const contentType = response.headers()['content-type'] || "none";
         logInfo(`Received response for ${url}: Status ${response.status()}, Content-Type: ${contentType}`);
         
         const status = response.status();
         if (status >= 400) {
             logInfo(`  Failed to load (status ${status}): ${url}`);
             throw new Error(`HTTP status ${status}`);
         }
         
         const finalUrl = response.url();
         const filePath = getFilePath(finalUrl);
         const dirPath = path.dirname(filePath);
         await fs.mkdir(dirPath, { recursive: true });
         const newLinks = await handleContentType(page, response, finalUrl);
         return newLinks;
     } catch (error) {
         throw error;
     }
}



async function loadConfig(configFile) {
    try {
        const defaultConfig = {
            force: false,
            depth: Infinity, // Default to no depth limit
            delay: 1,       // Default to 1s delay between requests
            maxRetries: 3,   // Default to 3 retries
            userAgent: null,
            headers: null,
        };
        const fileConfig = yaml.load(await fs.readFile(configFile, "utf8"));
        return { ...defaultConfig, ...fileConfig }; // Merge defaults and file config
    } catch (error) {
        console.error("Error reading config:", error);
        process.exit(1);
    }
}

async function loadAndMergeConfig(argv) {
  const configFile = argv.config || CRAWL_CONFIG_FILE;
  const fileConfig = await loadConfig(configFile);
  return { ...fileConfig, ...argv }; // CLI options override file settings.
}

function shouldSkipUrl(url, visited, exclusionPatterns, force) {
  return (!force && visited.has(url)) || shouldExclude(url, exclusionPatterns);
}

function processLinks(newLinks, queue, visited, exclusionPatterns, currentDepth) {
  newLinks.forEach(link => {
    if (visited.has(link)) {
      logInfo(`Duplicate link (already visited): ${link}`);
    } else if (shouldExclude(link, exclusionPatterns)) {
      logInfo(`Filtered link (excluded by pattern): ${link}`);
    } else {
      logInfo(`Enqueuing new link: ${link}`);
      visited.add(link); // Mark as visited when enqueuing
      queue.push({ url: link, depth: currentDepth + 1 });
    }
  });
}

async function parseCommandLineArgs() {
    const argv = yargs(hideBin(process.argv))
        .usage("Usage: crawl [options: --verbose, --force, --depth, --delay, --maxRetries, --config] <startUrl>")
        .option("verbose", { alias: "v", describe: "Enable verbose logging", type: "boolean" })
        .option("force", { alias: "f", describe: "Force re-crawl", type: "boolean" })
        .option("depth", { alias: "d", describe: "Maximum crawl depth", type: "number" })
        .option("delay", { alias: "l", describe: "Delay between requests (s)", type: "number" })
        .option("maxRetries", { alias: "r", describe: "Maximum retries", type: "number" })
        .option("config", { alias: "c", describe: "Config file path", type: "string", default: CRAWL_CONFIG_FILE })
        .demandCommand(1, "You must provide a start URL")
        .help()
        .argv;
    
    const config = await loadConfig(argv.config);
    
    return {
        startUrl: normalizeUrl(argv._[0]),
        force: argv.force !== undefined ? argv.force : config.force,
        depth: argv.depth !== undefined ? argv.depth : config.depth,
        delay: argv.delay !== undefined ? argv.delay : config.delay,
        maxRetries: argv.maxRetries !== undefined ? argv.maxRetries : config.maxRetries,
        userAgent: config.userAgent,
        headers: config.headers,
        configFile: argv.config
    };
}

async function loadConfigWithArgs() {
    const argv = yargs(hideBin(process.argv))
        .usage("Usage: crawl [options: --verbose, --force, --depth, --delay, --maxRetries, --config] <startUrl>")
        .option("force", { alias: "f", describe: "Force re-crawl", type: "boolean" })
        .option("depth", { alias: "d", describe: "Maximum crawl depth", type: "number" })
        .option("delay", { alias: "l", describe: "Delay between requests (s)", type: "number" })
        .option("maxRetries", { alias: "r", describe: "Maximum retries", type: "number" })
        .option("config", { alias: "c", describe: "Config file path", type: "string", default: CRAWL_CONFIG_FILE })
        .demandCommand(1, "You must provide a start URL")
        .help()
        .argv;
   
    return await loadAndMergeConfig(argv);
}

async function parseCommandLineArgsAndConfig() {
    const configData = await loadConfigWithArgs();
    // Set verbose default to false if undefined.
    const verbose = configData.verbose || false;
    return {
        config: {
            force: configData.force,
            depth: configData.depth,
            delay: configData.delay,
            maxRetries: configData.maxRetries,
            configFile: configData.config,
            userAgent: configData.userAgent,
            headers: configData.headers,
            verbose: verbose
        },
        startUrl: normalizeUrl(configData._[0])
    };
}

async function main() {
  const { config, startUrl } = await parseCommandLineArgsAndConfig();
  VERBOSE = config.verbose;  // enable verbose logging if flag is set

    const browser = await chromium.launch();
    const context = await browser.newContext({
        ignoreHTTPSErrors: true,
        ...(config.userAgent && { userAgent: config.userAgent }),
        ...(config.headers && { extraHTTPHeaders: config.headers }),
    });
    const page = await context.newPage();

    //Simplified request handling, as per requirements
    await page.route("**/*", (route) => {
      const requestUrl = route.request().url();
      if (requestUrl.toLowerCase().endsWith('.pdf')) {
          logInfo(`Route: PDF request allowed: ${requestUrl}`);
          return route.continue();
      }
      if (requestUrl.toLowerCase().startsWith('https://bpraneeth.com/medium_posts_mirror/') &&
          route.request().resourceType() === 'script') {
          return route.continue();
      }
      return /image|stylesheet|font|script/.test(route.request().resourceType())
          ? route.abort()
          : route.continue();
    });

    const visited = await loadCache();
    const exclusionPatterns = await loadExclusionPatterns(config.configFile);
    const queue = [{ url: startUrl, depth: 0 }];

    while (queue.length > 0) {
      const { url: currentUrl, depth: currentDepth } = queue.shift();

      if (shouldSkipUrl(currentUrl, visited, exclusionPatterns, config.force)) {
        logInfo(`Skipping URL: ${currentUrl}`);
        continue;
      }

      await wait(config.delay * 1000);

      // Wrap the crawlPage call in the retry logic.
      const newLinks = await retryWithBackoff(
        () => crawlPage(page, currentUrl, config),
        config.maxRetries
      );
      visited.add(currentUrl);

      if (currentDepth < config.depth) {
        processLinks(newLinks, queue, visited, exclusionPatterns, currentDepth);
      }
    }
    await saveCache(visited);
    await browser.close();
}
main().catch(error => {
  console.error("Error in main():", error);
});

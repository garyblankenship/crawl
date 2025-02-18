# Crawler - Simple Web Crawler

A simple, self-contained web crawler built with Playwright and Bun.

## Installation

1.  **Install Bun:** Follow the instructions on the official Bun website: [https://bun.sh/](https://bun.sh/)
2.  **Clone or Download:** Get the `crawl.js` script.
3.  **Install Dependencies:**
    ```bash
    bun install playwright yargs
    ```

## Usage

```bash
bun run crawl.js <start_url> [options]
```

**Arguments:**

*   `<start_url>`:  The URL to start crawling from. This is a required argument.

**Options:**

*   `-f`, `--force`: Force re-crawl of the start URL, even if it's in the cache.  (Default: `false`)
*   `-d`, `--depth`:  Maximum crawl depth. The crawler will not follow links beyond this depth. (Default: `2`)
*   `--delay`: Delay between requests in seconds.  This helps to avoid overwhelming the target server. (Default: `0`)
*   `--help`: Show this help message.

## Output

The crawler saves the HTML content of each crawled page to a directory structure under `./tmp/` that mirrors the website's URL structure. For example, if you crawl `https://example.com/blog/article1`, the HTML will be saved to `./tmp/example.com/blog/article1.html`.  If a path ends without a filename, `index.html` is used.

## Cache

The crawler maintains a cache of visited URLs in `./tmp/crawl_cache.txt`. This prevents re-crawling the same pages multiple times and allows the crawler to resume if interrupted.

## .crawlerignore

You can create a file named `.crawlerignore` in the same directory as the script.  This file contains a list of URL patterns (one per line) to exclude from the crawl.  Blank lines and lines starting with `#` are ignored.

**Example .crawlerignore:**

```
# Ignore CSS and JavaScript files
.css
.js

# Ignore a specific directory
/private/
```

## Resource Blocking

The crawler automatically blocks requests for images, stylesheets, and fonts to speed up crawling and reduce bandwidth usage.

## Limitations

*   **No Error Handling:** The crawler does not handle errors gracefully.  Network errors, invalid URLs, or other issues may cause the script to terminate.
*   **No Security Considerations:**  The crawler does not perform any security checks or sanitization.
*   **No JavaScript Rendering Beyond Initial Load:** The crawler uses `waitUntil: "networkidle"`, so it waits for initial JavaScript execution. However, it doesn't handle dynamically loaded content that happens *after* the `networkidle` event.  It's best suited for sites where the important content is present in the initial HTML or is loaded quickly.
* **Single Threaded** The crawler is not multi-threaded.

## Example

To crawl `https://example.com` with a maximum depth of 3 and a 1-second delay between requests:

```bash
bun run crawl.js https://example.com -d 3 --delay 1
```

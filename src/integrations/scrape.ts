import * as cheerio from "cheerio";
import type { HttpClient } from "./http.ts";

export interface ScrapeClient {
  /** Fetches a page and returns a Cheerio document (jQuery-style selectors). */
  page(url: string, opts?: { headers?: Record<string, string> }): Promise<cheerio.CheerioAPI>;
  /** Trimmed text of the first match, or null. */
  text(url: string, selector: string): Promise<string | null>;
  /** Trimmed text of every match. */
  textAll(url: string, selector: string): Promise<string[]>;
  /** Parses HTML you already have. */
  parse(html: string): cheerio.CheerioAPI;
}

const UA =
  "Mozilla/5.0 (compatible; automator/0.1; +https://github.com/huzaifah-s/automator)";

export function createScrape(http: HttpClient): ScrapeClient {
  return {
    async page(url, opts = {}) {
      const html = await http.get<string>(url, {
        as: "text",
        headers: { "user-agent": UA, accept: "text/html,*/*", ...opts.headers },
      });
      return cheerio.load(html);
    },

    async text(url, selector) {
      const $ = await this.page(url);
      const found = $(selector).first().text().trim();
      return found || null;
    },

    async textAll(url, selector) {
      const $ = await this.page(url);
      return $(selector)
        .map((_i, el) => $(el).text().trim())
        .get()
        .filter(Boolean);
    },

    parse: (html) => cheerio.load(html),
  };
}

// File: pages/api/fetchHtmlToJson.js

import TurndownService from "turndown"; // This is the correct import for Node.js

const cheerio = require("cheerio");
const htmlToMarkdownUpdate = require("html-to-markdown");
const showdown = require("showdown");
const { convert } = require("html-to-markdown");

export default async function getScrape(url) {
  if (!url) return;

  try {
    const response = await fetch(url);
    const htmlText = await response.text();

    const $ = cheerio.load(htmlText);

    // Remove unwanted elements
    $("script, style, iframe, meta, footer, noscript").remove();

    // Custom markdown conversion function
    function convertToMarkdown(element) {
      if (!element) return "";

      const convertChildren = (el) => {
        return $(el)
          .children()
          .map((i, child) => {
            return convertToMarkdown(child);
          })
          .get()
          .join("\n");
      };

      switch (element.name) {
        case "h1":
          return `# ${$(element).text()}\n`;
        case "h2":
          return `## ${$(element).text()}\n`;
        case "h3":
          return `### ${$(element).text()}\n`;
        case "h4":
          return `#### ${$(element).text()}\n`;
        case "h5":
          return `##### ${$(element).text()}\n`;
        case "h6":
          return `###### ${$(element).text()}\n`;
        case "p":
          return `${$(element).text()}\n`;
        case "ul":
          return (
            $(element)
              .children("li")
              .map((i, li) => `- ${$(li).text()}`)
              .get()
              .join("\n") + "\n"
          );
        case "ol":
          return (
            $(element)
              .children("li")
              .map((i, li) => `${i + 1}. ${$(li).text()}`)
              .get()
              .join("\n") + "\n"
          );
        case "a":
          return `[${$(element).text()}](${$(element).attr("href")})`;
        case "img":
          return `![${$(element).attr("alt") || ""}](${$(element).attr(
            "src"
          )})`;
        case "strong":
        case "b":
          return `**${$(element).text()}**`;
        case "em":
        case "i":
          return `*${$(element).text()}*`;
        case "code":
          return `\`${$(element).text()}\``;
        case "blockquote":
          return `> ${$(element).text()}\n`;
        default:
          return convertChildren(element);
      }
    }

    // Convert body to markdown
    const markdown = $("body")
      .children()
      .map((i, el) => convertToMarkdown(el))
      .get()
      .join("\n");

    return {
      success: true,
      data: { markdown },
    };
  } catch (error) {
    console.error("Error fetching or parsing HTML:", error);
  }
}

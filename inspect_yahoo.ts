import axios from 'axios';
import * as cheerio from 'cheerio';

async function inspectYahooPrice(symbol: string) {
  const url = `https://tw.stock.yahoo.com/quote/${symbol}.TW`;
  console.log(`Fetching ${url}`);
  try {
    const res = await axios.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    const $ = cheerio.load(res.data);
    
    // Look for price
    // Usually in a span with class like "Fz(32px)" or similar
    // Let's dump all spans with Fz class to see
    $('span').each((i, el) => {
      const cls = $(el).attr('class');
      if (cls && cls.includes('Fz(')) {
        console.log(`Span with class ${cls}: ${$(el).text()}`);
      }
    });
    
    const price = $('span[class*="Fz(32px)"]').first().text();
    console.log(`Price found with Fz(32px): ${price}`);
    
    const name = $('h1').first().text();
    console.log(`Name found: ${name}`);
    
  } catch (error) {
    console.error(`Error fetching price for ${symbol}:`, error);
  }
}

inspectYahooPrice('00894');

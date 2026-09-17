// Generates build/icon.ico (and .png) for the app — renders the brand mark with
// the Chromium we already have and wraps the PNG into a 256x256 ICO.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

function pngToIco(png) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(1, 4); // count
  const entry = Buffer.alloc(16);
  entry.writeUInt8(0, 0); // width 256 -> 0
  entry.writeUInt8(0, 1); // height 256 -> 0
  entry.writeUInt8(0, 2); // palette
  entry.writeUInt8(0, 3); // reserved
  entry.writeUInt16LE(1, 4); // color planes
  entry.writeUInt16LE(32, 6); // bits per pixel
  entry.writeUInt32LE(png.length, 8); // size of image data
  entry.writeUInt32LE(22, 12); // offset (6 + 16)
  return Buffer.concat([header, entry, png]);
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 256, height: 256 }, deviceScaleFactor: 1 });
  await page.setContent(`
    <div id="i" style="width:256px;height:256px;border-radius:58px;
      background:#fff;display:flex;align-items:center;justify-content:center;">
      <div style="width:0;height:0;margin-left:18px;
        border-left:74px solid #000;
        border-top:46px solid transparent;
        border-bottom:46px solid transparent;"></div>
    </div>`);
  const png = await page.locator('#i').screenshot({ omitBackground: true });
  await browser.close();

  fs.mkdirSync(path.join(__dirname, 'build'), { recursive: true });
  fs.writeFileSync(path.join(__dirname, 'build', 'icon.png'), png);
  fs.writeFileSync(path.join(__dirname, 'build', 'icon.ico'), pngToIco(png));
  console.log('wrote build/icon.ico (' + png.length + ' bytes png)');
})();

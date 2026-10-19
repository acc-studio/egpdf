// Generates the fixture PDF used by the end-to-end suite: three pages with
// text to redact/search, an AcroForm page (text fields, checkbox, multiline
// notes with an adversarial auto-fit font size), and a search target page.
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { writeFileSync } from 'fs';
import { deflateRawSync, crc32 } from 'zlib';

const outPath = process.argv[2];
if (!outPath) {
  console.error('usage: node test/make-sample.mjs <output.pdf>');
  process.exit(1);
}

const doc = await PDFDocument.create();
const font = await doc.embedFont(StandardFonts.Helvetica);
const bold = await doc.embedFont(StandardFonts.HelveticaBold);

const p1 = doc.addPage([595, 842]);
p1.drawText('CONFIDENTIAL SETTLEMENT AGREEMENT', { x: 60, y: 770, size: 16, font: bold });
p1.drawText('This Agreement is entered into by and between the parties below.', { x: 60, y: 730, size: 11, font });
p1.drawText('Client SSN: 123-45-6789 (sensitive - to be redacted)', { x: 60, y: 700, size: 11, font, color: rgb(0.6, 0, 0) });
let y = 660;
for (let i = 1; i <= 12; i++) {
  p1.drawText(`${i}. The parties agree to the terms and conditions described in section ${i} herein.`, { x: 60, y, size: 11, font });
  y -= 26;
}

const p2 = doc.addPage([595, 842]);
p2.drawText('INTAKE FORM', { x: 60, y: 770, size: 16, font: bold });
const form = doc.getForm();

p2.drawText('Full name:', { x: 60, y: 720, size: 11, font });
form.createTextField('client.name').addToPage(p2, { x: 150, y: 708, width: 260, height: 22 });

p2.drawText('Case number:', { x: 60, y: 680, size: 11, font });
form.createTextField('case.number').addToPage(p2, { x: 150, y: 668, width: 160, height: 22 });

p2.drawText('Retainer signed:', { x: 60, y: 640, size: 11, font });
form.createCheckBox('retainer.signed').addToPage(p2, { x: 160, y: 630, width: 16, height: 16 });

p2.drawText('Notes:', { x: 60, y: 600, size: 11, font });
const notes = form.createTextField('notes');
notes.enableMultiline();
notes.addToPage(p2, { x: 60, y: 480, width: 470, height: 110 });

const p3 = doc.addPage([595, 842]);
p3.drawText('Page 3 - searching for the word aardvark should land here.', { x: 60, y: 770, size: 12, font });
p3.drawText('The aardvark appears twice: aardvark.', { x: 60, y: 740, size: 12, font });

writeFileSync(outPath, await doc.save());
console.log('fixture written:', outPath);

// A small UYAP document (.udf) next to it: Turkish text with a bold run, a
// numbered list and a two-column table — the shapes real court documents use.
const udfText = '\nŞişli 3. Asliye Hukuk Mahkemesine\nığüşöç İĞÜŞÖÇ metni\nBirinci madde\nİkinci madde\nHücre\nDeğer\n';
const at = (s) => udfText.indexOf(s);
const run = (s, extra = '') => `<content family="Times New Roman" size="12"${extra} startOffset="${at(s)}" length="${s.length + 1}" />`;
const contentXml = `<?xml version="1.0" encoding="UTF-8" ?>
<template format_id="1.8">
<content><![CDATA[${udfText}]]></content>
<properties><pageFormat mediaSizeName="1" leftMargin="70.0" rightMargin="70.0" topMargin="56.7" bottomMargin="56.7" paperOrientation="1" headerFOffset="20.0" footerFOffset="20.0" /></properties>
<elements resolver="hvl-default">
<paragraph Alignment="1"><content startOffset="0" length="1" /></paragraph>
<paragraph Alignment="1">${run('Şişli 3. Asliye Hukuk Mahkemesine', ' bold="true"')}</paragraph>
<paragraph Alignment="3">${run('ığüşöç İĞÜŞÖÇ metni')}</paragraph>
<paragraph Numbered="true" NumberType="NUMBER_TYPE_NUMBER_DOT" ListId="1" ListLevel="1" LeftIndent="25.0">${run('Birinci madde')}</paragraph>
<paragraph Numbered="true" NumberType="NUMBER_TYPE_NUMBER_DOT" ListId="1" ListLevel="1" LeftIndent="25.0">${run('İkinci madde')}</paragraph>
<table tableName="T1" columnCount="2" columnSpans="30,70" border="borderNone"><row rowName="r1" rowType="dataRow"><cell><paragraph>${run('Hücre', ' bold="true"')}</paragraph></cell><cell><paragraph>${run('Değer')}</paragraph></cell></row></table>
</elements>
<styles><style name="hvl-default" family="Times New Roman" size="12" description="Gövde" /></styles>
</template>`;
writeFileSync(outPath.replace(/\.pdf$/i, '.udf'), zipOne('content.xml', Buffer.from(contentXml, 'utf8')));

// single-entry ZIP (deflate), enough for a .udf
function zipOne(name, data) {
  const nameBuf = Buffer.from(name);
  const comp = deflateRawSync(data);
  const crc = crc32(data);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8);
  local.writeUInt32LE(crc, 14); local.writeUInt32LE(comp.length, 18); local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
  central.writeUInt16LE(8, 10); central.writeUInt32LE(crc, 16); central.writeUInt32LE(comp.length, 20);
  central.writeUInt32LE(data.length, 24); central.writeUInt16LE(nameBuf.length, 28);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
  end.writeUInt32LE(46 + nameBuf.length, 12); end.writeUInt32LE(30 + nameBuf.length + comp.length, 16);
  return Buffer.concat([local, nameBuf, comp, central, nameBuf, end]);
}

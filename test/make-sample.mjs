// Generates the fixture PDF used by the end-to-end suite: three pages with
// text to redact/search, an AcroForm page (text fields, checkbox, multiline
// notes with an adversarial auto-fit font size), and a search target page.
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { writeFileSync } from 'fs';

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

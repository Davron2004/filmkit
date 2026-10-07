// ─────────────────────────────────────────────────────────────────────────────
// examples/web/tip-demo.demo.mjs — a compiled walkthrough of the bundled fixture page
// (examples/web/fixture.html), demonstrating the whole web-stage API. Run it:
//
//   node film-web.mjs examples/web/tip-demo.demo.mjs --tighten
//
// Selectors: the fixture renders `<label><span>{label}</span><input/></label>` — no testids,
// so we match on the label text with `:has-text("…")`, never by position. The computed rows
// do have ids, so they are targeted by id. Every target here is a plain selector STRING, which
// is what both cameras understand — `--browser ego` cannot take a Playwright Locator.
import { fileURLToPath } from 'node:url';

export default async function tipDemo({ stage }) {
  // open() accepts an http(s) URL or a local file path. Here we resolve the sibling fixture.
  // fileURLToPath, not `.pathname`: a URL's pathname is percent-ENCODED, so a repo checked out
  // under a directory with a space in it yields ".../my%20repo/fixture.html", which is not a
  // path any filesystem has. This is the correct way to turn an import.meta.url into a path.
  // `cursorAt` is where the cursor starts. The h1 is as wide as the card, so its center is the empty
  // space to the right of the title: the opening frame shows the cursor beside the app's name instead
  // of at the viewport center, which on this page is the People field's bottom border.
  await stage.open(fileURLToPath(new URL('./fixture.html', import.meta.url)), { cursorAt: 'h1' });

  await stage.caption('Meet Tip Splitter — split any bill in seconds.');
  await stage.pause(2600);
  await stage.clearCaption();
  await stage.pause(400);

  await stage.caption('Enter the bill.');
  await stage.type('label:has-text("Bill") input', '86');
  await stage.pause(1000);
  await stage.clearCaption();

  await stage.caption('Adjust the tip percentage.');
  await stage.type('label:has-text("Tip %") input', '18');
  await stage.pause(1000);
  await stage.clearCaption();

  await stage.caption('Split it across the table.');
  await stage.type('label:has-text("People") input', '3');
  await stage.pause(1000);
  await stage.clearCaption();
  // Leave the field, as a user does once the value is in: a focused number input keeps its focus ring
  // and spinner on screen, through the results and the closing narration.
  await stage.page.evaluate('document.activeElement?.blur()');

  await stage.caption('Tip, total, and per-person share — computed live.');
  // The ROW, not the value: the row's center is the gap between its label and its amount, so the
  // pointer marks the line without covering the digits the caption is about.
  await stage.point('#per-person-row');
  await stage.pause(3600);
  await stage.clearCaption();
  await stage.pause(400);

  await stage.caption('Reset brings it back to the defaults.');
  await stage.click('#reset');
  await stage.point('#per-person-row'); // off the button's label, onto the values that just reset
  await stage.pause(1800);
  await stage.clearCaption();

  await stage.caption('That’s the whole demo.');
  await stage.pause(2200);
  await stage.clearCaption();
  await stage.pause(800);
}

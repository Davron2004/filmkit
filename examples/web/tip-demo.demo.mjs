// ─────────────────────────────────────────────────────────────────────────────
// examples/web/tip-demo.demo.mjs — a compiled walkthrough of the bundled fixture page
// (examples/web/fixture.html), demonstrating the whole web-stage API. Run it:
//
//   node film-web.mjs examples/web/tip-demo.demo.mjs --tighten
//
// Selectors: the fixture renders `<label><span>{label}</span><input/></label>` — no testids,
// so we match on the label text. The computed rows are targeted by filtering on their own
// label text, never by position.
export default async function tipDemo({ stage }) {
  // open() accepts an http(s) URL or a local file path. Here we resolve the sibling fixture.
  await stage.open(new URL('./fixture.html', import.meta.url).pathname);

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

  await stage.caption('Tip, total, and per-person share — computed live.');
  await stage.point((page) => page.locator('.row').filter({ hasText: 'Per person' }).locator('span').last());
  await stage.pause(3600);
  await stage.clearCaption();
  await stage.pause(400);

  await stage.caption('Reset brings it back to the defaults.');
  await stage.click('#reset');
  await stage.pause(1800);
  await stage.clearCaption();

  await stage.caption('That’s the whole demo.');
  await stage.pause(2200);
  await stage.clearCaption();
  await stage.pause(800);
}

// ─────────────────────────────────────────────────────────────────────────────
// examples/web/generate.demo.mjs — filming an app whose result is not deterministic, with the
// stage's checkpoint (expect) and branch point (oneOf). The page, examples/web/generate.html,
// "generates" for a random 2-6s and then either shows a preview or a build error. Run it:
//
//   node film-web.mjs examples/web/generate.demo.mjs --tighten
//
// FORCING AN OUTCOME: the page reads `?outcome=ok` or `?outcome=fail`; with neither it picks at
// random. To film one on purpose, add the parameter to PAGE below, e.g.
// `new URL('./generate.html?outcome=fail', import.meta.url)`. A file: URL keeps its query on both
// cameras. (An environment variable would not do: under --browser ego the flow runs inside the
// ego-browser runtime, which does not see film-web's environment.)
//
// WHAT HAPPENS ON EACH BRANCH. oneOf() returns which target appeared first, and the flow branches
// in plain JS. `filmAccept: ['built']` says a take is only worth keeping when the build worked, so
// on camera a "failed" outcome fails the take (status flow-failed, saved as `.failed*`, exit 1,
// the sidecar's `outcomes` says what happened) and you film again. The "failed" branch below still
// matters: a test run of this same flow (Part 2's scenarios) accepts either outcome, because the
// walkthrough works whichever way the generator went.
//
// TIGHTEN AND THE WAIT: no caption is up while oneOf() waits. A caption range is a protected hold
// (tighten never cuts it), so a caption held across the wait would keep all of it; without one,
// the static "Generating…" stretch is dead air and --tighten cuts it down.
export default async function generateDemo({ stage }) {
  const PAGE = new URL('./generate.html', import.meta.url);
  // The cursor starts where it rests later, in the gap under the Generate button (see below), not at
  // the viewport center, which on this page is inside the result panel. (Beside the title would crowd
  // it: the subtitle sits 5px under a cursor parked there.)
  await stage.open(PAGE.href, { cursorAt: '[data-testid=gap]' });

  await stage.caption('Describe the page you want.');
  // type() clicks the field's center and the cursor stays there while the keys go in, so a prompt
  // longer than half the field runs under it. This one ends left of the center, and so does the
  // field's placeholder (the same text), which is on screen as the cursor arrives.
  await stage.type('#prompt', 'A bakery homepage');
  await stage.pause(600);
  await stage.clearCaption();

  await stage.caption('Then generate it.');
  await stage.click('[data-testid=generate]');
  // Rest the pointer off the button's label while the app works, in the gap between the Generate
  // button and the result panel (an element in the page for exactly this, see generate.html): its tip
  // stays out of the panel, and nothing it overlaps has text in any state of the page.
  await stage.point('[data-testid=gap]');
  await stage.expect('[data-testid=generating]', { text: 'Generating' });
  await stage.clearCaption(); // before the wait, not after: see TIGHTEN AND THE WAIT above

  const build = await stage.oneOf(
    { built: '[data-testid=preview]', failed: '[data-testid=build-error]' },
    { name: 'build', timeoutMs: 20_000, filmAccept: ['built'] },
  );

  if (build === 'built') {
    await stage.caption('It runs. Publish it in one click.');
    await stage.pause(1200);
    await stage.click('[data-testid=publish]');
    await stage.point('[data-testid=gap]'); // off "Published", which replaces the button under the pointer
    await stage.expect('[data-testid=publish-status]', { text: 'Published' });
    await stage.pause(1600);
  } else {
    await stage.caption('It explains what broke, and offers a retry.');
    await stage.expect('[data-testid=retry]');
    await stage.pause(2400);
  }
  await stage.clearCaption();
  await stage.pause(400);
}

import { expect, test, type Page } from '@playwright/test';

/** E2 (wound) preset: f1 = f0 sqrt(1 + B) with B = 1.47e-4. */
const E2_F1 = 82.4069 * Math.sqrt(1 + 1.466e-4);

async function ready(page: Page, query = '') {
  await page.goto(`./${query}`);
  await expect(page.locator('html')).toHaveAttribute('data-ready', 'true', { timeout: 20_000 });
}

/** Number of measurements completed so far (each excitation produces one). */
async function count(page: Page): Promise<number> {
  return Number((await page.locator('#f0-readout').getAttribute('data-count')) ?? 0);
}

/** Waits until more than `after` measurements exist; returns the measured fundamental (Hz). */
async function measuredF0(page: Page, after = -1): Promise<number> {
  const out = page.locator('#f0-readout');
  await expect
    .poll(
      async () =>
        (await count(page)) > after && (await out.getAttribute('data-state')) !== 'measuring',
      {
        timeout: 15_000,
      },
    )
    .toBe(true);
  return Number(await out.getAttribute('data-measured-f0'));
}

async function dragPluck(page: Page, xFraction: number, dy: number) {
  const box = await page.locator('#string-target').boundingBox();
  if (!box) throw new Error('string target not found');
  const x = box.x + box.width * xFraction;
  const y = box.y + box.height * 0.5;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y + dy, { steps: 8 });
  await page.mouse.up();
}

test('dragging and releasing the string plucks it, and the measured f0 matches theory', async ({
  page,
}) => {
  await ready(page);
  await measuredF0(page); // the opening example
  const before = await count(page);
  await dragPluck(page, 0.7, -40);
  const f0 = await measuredF0(page, before);
  expect(Math.abs(1200 * Math.log2(f0 / E2_F1))).toBeLessThan(5);
  await expect(page.locator('#stage-hint')).toHaveClass(/is-hidden/);
  // The pluck point follows the finger: about 0.3 of the length from the bridge.
  const valueNow = Number(await page.locator('#string-target').getAttribute('aria-valuenow'));
  expect(valueNow).toBeGreaterThan(20);
  expect(valueNow).toBeLessThan(40);
  // The first gesture unlocks audio (or reports clearly why it cannot).
  await expect(page.locator('#sound-pill')).not.toHaveAttribute('data-status', 'idle');
});

test('changing the preset changes the measured fundamental', async ({ page }) => {
  await ready(page);
  const first = await measuredF0(page);
  expect(Math.abs(first - E2_F1)).toBeLessThan(1);
  let n = await count(page);
  await page.locator('.chip[data-preset="guitar-e4"]').click();
  await expect(page.locator('.chip[data-preset="guitar-e4"]')).toHaveAttribute(
    'aria-checked',
    'true',
  );
  const second = await measuredF0(page, n);
  n = await count(page);
  expect(Math.abs(1200 * Math.log2(second / 329.63))).toBeLessThan(5);
  await page.locator('.chip[data-preset="piano-a0"]').click();
  const third = await measuredF0(page, n);
  expect(Math.abs(third - 27.5)).toBeLessThan(0.3);
});

test('plucking at one third suppresses partials 3, 6 and 9', async ({ page }) => {
  await ready(page);
  await page.locator('#fractions button[data-fraction="3"]').click();
  await expect(page.locator('#fractions button[data-fraction="3"]')).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  const third = page.locator('#partials-body tr[data-partial="3"]');
  await expect(third).toHaveAttribute('data-suppressed', 'true', { timeout: 15_000 });
  await expect(third).toHaveAttribute('data-predicted-suppressed', 'true');
  await expect(page.locator('#partials-body tr[data-partial="6"]')).toHaveAttribute(
    'data-suppressed',
    'true',
  );
  await expect(page.locator('#partials-body tr[data-partial="2"]')).toHaveAttribute(
    'data-suppressed',
    'false',
  );
  await expect(page.locator('#spectrum-notes')).toContainText('Partials 3, 6, 9');
  await expect(page.locator('#spectrum-status')).toContainText('suppressed');
});

test('striking with the hammer gives the same pitch and a different comb', async ({ page }) => {
  await ready(page);
  await page.locator('.segmented label', { hasText: 'Strike' }).first().click();
  await expect(page.locator('#strike-panel')).toBeVisible();
  await expect(page.locator('#excite-label')).toHaveText('Strike');
  const f0 = await measuredF0(page);
  expect(Math.abs(1200 * Math.log2(f0 / E2_F1))).toBeLessThan(5);
  // The default strike point is L/8: partial 8 vanishes.
  await expect(page.locator('#spectrum-notes')).toContainText('struck at L/8');
});

test('the keyboard retunes the tension to each note', async ({ page }) => {
  await ready(page);
  // The string itself is operable from the keyboard.
  await page.locator('#string-target').focus();
  await page.keyboard.press('ArrowRight');
  await measuredF0(page);
  let n = await count(page);
  await page.keyboard.press('Enter');
  await measuredF0(page, n);
  n = await count(page);
  // Computer key T is G in the upper row, i.e. G2 on this string's keyboard (C1-C3). Retuning
  // raises T, so B falls as (82.41 / 98.00)^2 and f1 = 98.00 sqrt(1 + B).
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('KeyT');
  const g2 = await measuredF0(page, n);
  n = await count(page);
  const g2Expected = 97.9989 * Math.sqrt(1 + 1.466e-4 * (82.4069 / 97.9989) ** 2);
  expect(Math.abs(1200 * Math.log2(g2 / g2Expected))).toBeLessThan(5);
  await expect(page.locator('#keyboard-note')).toContainText('G2');
  // The on-screen key does the same.
  await page.locator('.key[data-midi="36"]').click(); // C2
  const c2 = await measuredF0(page, n);
  expect(Math.abs(1200 * Math.log2(c2 / 65.406))).toBeLessThan(5);
});

test('a slider at the end of its range explains why it stops there', async ({ page }) => {
  await ready(page);
  const stiffness = page.locator('#p-string-inharmonicity');
  await stiffness.focus();
  await page.keyboard.press('End');
  const note = page.locator('.field[data-param="string.inharmonicity"] .field-note');
  await expect(note).toBeVisible();
  await expect(note).toContainText(/bar|stability/);
  await expect(
    page.locator('.field[data-param="string.inharmonicity"] .link-button'),
  ).toBeVisible();
  // Partials stretch: the annotation reports a large deviation from n f0.
  await expect(page.locator('#spectrum-notes')).toContainText('above 20');
});

test('without AudioWorklet the string is played from the main thread', async ({ page }) => {
  await ready(page, '?audio=fallback');
  await measuredF0(page);
  const n = await count(page);
  await page.locator('#excite').click();
  await expect(page.locator('#sound-pill')).toHaveAttribute(
    'data-status',
    /running|starting|suspended|failed/,
  );
  const f0 = await measuredF0(page, n);
  expect(Math.abs(1200 * Math.log2(f0 / E2_F1))).toBeLessThan(5);
  const status = await page.locator('#sound-pill').getAttribute('data-status');
  if (status === 'running') {
    await expect(page.locator('#sound-label')).toContainText('fallback');
    await expect(page.locator('#listen-note')).toContainText('AudioWorklet');
  }
});

test('without Web Audio the simulation still runs and says so', async ({ page }) => {
  await ready(page, '?audio=off');
  await expect(page.locator('#sound-label')).toHaveText('No sound in this browser');
  await expect(page.locator('#sound-pill')).toBeDisabled();
  await page.locator('#excite').click();
  await expect(page.locator('#listen-note')).toContainText('no Web Audio');
  const f0 = await measuredF0(page);
  expect(Math.abs(1200 * Math.log2(f0 / E2_F1))).toBeLessThan(5);
});

test('reduced motion starts without the slow-motion animation', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await ready(page);
  await expect(page.locator('#slowmo')).not.toBeChecked();
  await page.locator('#excite').click();
  await measuredF0(page);
  await page.locator('#pause').click();
  await expect(page.locator('#pause')).toHaveAttribute('aria-pressed', 'true');
});

test('"How it works" renders the equations and the validation table', async ({ page }) => {
  await ready(page);
  await page
    .locator('.topbar a[href="#how"]')
    .first()
    .click({ force: true })
    .catch(() => undefined);
  await page.locator('#how').scrollIntoViewIfNeeded();
  await expect(page.locator('#how .katex').first()).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('#how')).toContainText('Validation');
  await expect(page.locator('#how .how-table').first()).toContainText('Pluck at L/3');
});

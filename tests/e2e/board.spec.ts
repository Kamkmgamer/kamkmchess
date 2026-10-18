import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

async function startLocal(page: Page, fen = '') {
  await page.goto('/');
  await page.getByRole('button', { name: 'New game', exact: true }).click();
  await page.getByLabel('Game mode').selectOption('local');
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  if (fen) {
    await page.getByRole('button', { name: 'Custom starting position', exact: true }).click();
    await page.getByLabel('Custom starting position (six-field FEN)').fill(fen);
    await page.getByRole('button', { name: 'Done', exact: true }).click();
  }
  await page.getByRole('button', { name: 'Start game', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Type a move', exact: true })).toBeEnabled();
  await page.locator('cg-board').scrollIntoViewIfNeeded();
}

async function point(page: Page, square: string, corner = false, flipped = false) {
  const box = await page.locator('cg-board').boundingBox();
  if (!box) throw new Error(`Missing square ${square}`);
  const file = square.charCodeAt(0) - 97;
  const rank = Number(square[1]) - 1;
  return {
    x: box.x + (flipped ? 7 - file : file) * box.width / 8 + (corner ? 3 : box.width / 16),
    y: box.y + (flipped ? rank : 7 - rank) * box.height / 8 + (corner ? 3 : box.height / 16),
  };
}

const squareKeys = (page: Page, selector: string) => page.locator(`${selector}:visible`).evaluateAll((elements) => elements.map((element) => Reflect.get(element, 'cgKey')).sort());

test('a legal drag never flashes back to its origin after release', async ({ page }) => {
  await startLocal(page);
  const from = await point(page, 'e2', true);
  const to = await point(page, 'e4');
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 8 });
  await expect(page.locator('cg-board piece.dragging')).toBeVisible();
  await page.evaluate(() => {
    const frames: string[] = [];
    Object.assign(window, { boardFrames: frames });
    window.addEventListener('mouseup', () => {
      const sample = () => {
        const source = [...document.querySelectorAll('cg-board piece:not(.ghost)')].find((piece) => Reflect.get(piece, 'cgKey') === 'e2');
        if (source) frames.push('origin');
        else frames.push('moved');
        if (frames.length < 20) requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    }, { once: true });
  });
  await page.mouse.up();
  await expect(page.getByRole('table', { name: 'Committed moves' }).getByRole('button')).toHaveCount(1);
  await expect.poll(() => page.evaluate(() => Reflect.get(window, 'boardFrames').length)).toBe(20);
  expect(await page.evaluate(() => Reflect.get(window, 'boardFrames'))).not.toContain('origin');
});

test('square edges select pieces and show legal destinations and last move', async ({ page }) => {
  await startLocal(page);
  const from = await point(page, 'e2', true);
  await page.mouse.click(from.x, from.y);
  await expect.poll(() => squareKeys(page, 'square.move-dest')).toEqual(['e3', 'e4']);
  const to = await point(page, 'e4', true);
  await page.mouse.click(to.x, to.y);
  await expect.poll(() => squareKeys(page, 'square.last-move')).toEqual(['e2', 'e4']);
  await expect(page.locator('square.move-dest:visible')).toHaveCount(0);
});

test('square-edge hit testing follows board movement without a resize', async ({ page }) => {
  await startLocal(page);
  // Prime Chessground's bounds cache, then simulate a position-only layout
  // shift. ResizeObserver does not fire when the board keeps its dimensions.
  const empty = await point(page, 'a3');
  await page.mouse.click(empty.x, empty.y);
  await page.locator('.board-host').evaluate((element) => {
    element.style.transform = 'translateY(-16px)';
  });
  const from = await point(page, 'e2', true);
  await page.mouse.click(from.x, from.y);
  await expect.poll(() => squareKeys(page, 'square.move-dest')).toEqual(['e3', 'e4']);
  const to = await point(page, 'e4', true);
  await page.mouse.click(to.x, to.y);
  await expect.poll(() => squareKeys(page, 'square.last-move')).toEqual(['e2', 'e4']);
});

test('click moves animate through intermediate positions', async ({ page }) => {
  await startLocal(page);
  const from = await point(page, 'e2');
  const to = await point(page, 'e4');
  await page.mouse.click(from.x, from.y);
  await page.evaluate(() => {
    const positions: number[] = [];
    Object.assign(window, { animatedPositions: positions });
    let count = 0;
    const sample = () => {
      const piece = [...document.querySelectorAll('cg-board piece.white.pawn')].find((item) => Reflect.get(item, 'cgKey') === 'e4');
      if (piece) positions.push(piece.getBoundingClientRect().y);
      if (++count < 30) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  await page.mouse.click(to.x, to.y);
  await expect.poll(() => page.evaluate(() => Reflect.get(window, 'animatedPositions').length)).toBeGreaterThan(4);
  const box = await page.locator('cg-board').boundingBox();
  if (!box) throw new Error('Missing board');
  const end = to.y - box.height / 16;
  const start = from.y - box.height / 16;
  const positions: number[] = await page.evaluate(() => Reflect.get(window, 'animatedPositions'));
  expect(positions.some((y) => y > end + 2 && y < start - 2)).toBe(true);
});

test('illegal drops leave the position unchanged and allow another drag', async ({ page }) => {
  await startLocal(page);
  const from = await point(page, 'e2', true);
  const illegal = await point(page, 'e5');
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(illegal.x, illegal.y, { steps: 6 });
  await page.mouse.up();
  await expect(page.getByRole('table', { name: 'Committed moves' }).getByRole('button')).toHaveCount(0);
  await expect.poll(() => squareKeys(page, 'piece.white.pawn')).toContain('e2');
  const legal = await point(page, 'e4');
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(legal.x, legal.y, { steps: 6 });
  await page.mouse.up();
  await expect(page.getByRole('table', { name: 'Committed moves' }).getByRole('button')).toHaveCount(1);
});

for (const fixture of [
  { name: 'castling', fen: 'r3k2r/pppppppp/8/8/8/8/PPPPPPPP/R3K2R w KQkq - 0 1', from: 'e1', to: 'g1', role: 'rook', occupied: 'f1', empty: 'h1' },
  { name: 'en passant', fen: 'rnbqkbnr/ppp1pppp/8/3pP3/8/8/PPPP1PPP/RNBQKBNR w KQkq d6 0 3', from: 'e5', to: 'd6', role: 'pawn', occupied: 'd6', empty: 'd5' },
]) {
  test(`${fixture.name} reconciles all affected pieces`, async ({ page }) => {
    await startLocal(page, fixture.fen);
    const from = await point(page, fixture.from, true);
    const to = await point(page, fixture.to);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await expect.poll(() => squareKeys(page, 'square.move-dest')).toContain(fixture.to);
    await page.mouse.move(to.x, to.y, { steps: 6 });
    await page.mouse.up();
    await expect(page.getByRole('table', { name: 'Committed moves' }).getByRole('button')).toHaveCount(1);
    await expect.poll(() => squareKeys(page, `piece.white.${fixture.role}`)).toContain(fixture.occupied);
    await expect.poll(() => squareKeys(page, 'cg-board piece')).not.toContain(fixture.empty);
    await expect.poll(() => squareKeys(page, 'square.last-move')).toEqual([fixture.from, fixture.to].sort());
  });
}

test('promotion waits for a piece choice and renders the chosen piece', async ({ page }) => {
  await startLocal(page, 'rnbqkbnr/1Ppppppp/8/8/8/8/P1PPPPPP/RNBQKBNR w KQkq - 0 1');
  const from = await point(page, 'b7', true);
  const to = await point(page, 'a8');
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await expect(page.locator('square.move-dest.oc:visible')).toHaveCount(2);
  await page.mouse.move(to.x, to.y, { steps: 6 });
  await page.mouse.up();
  await expect(page.getByRole('region', { name: 'Promotion' })).toBeVisible();
  await expect(page.getByRole('table', { name: 'Committed moves' }).getByRole('button')).toHaveCount(0);
  await page.getByRole('region', { name: 'Promotion' }).getByRole('button', { name: 'Knight', exact: true }).click();
  await expect(page.getByRole('table', { name: 'Committed moves' }).getByRole('button')).toHaveCount(1);
  await expect.poll(() => squareKeys(page, 'piece.white.knight')).toContain('a8');
});

test('highlights survive flip and reload and follow undo', async ({ page }) => {
  await startLocal(page);
  for (const move of ['e2e4', 'e7e5']) {
    await expect(page.getByRole('button', { name: 'Type a move', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: 'Type a move', exact: true }).click();
    await page.getByLabel('Enter a move by coordinates').fill(move);
    await page.getByRole('button', { name: 'Play move', exact: true }).click();
  }
  await expect.poll(() => squareKeys(page, 'square.last-move')).toEqual(['e5', 'e7']);
  await page.getByRole('button', { name: 'Flip board' }).click();
  await expect(page.locator('.board-host')).toHaveClass(/orientation-black/);
  await expect.poll(() => squareKeys(page, 'square.last-move')).toEqual(['e5', 'e7']);
  await page.reload();
  await expect.poll(() => squareKeys(page, 'square.last-move')).toEqual(['e5', 'e7']);
  await expect(page.getByRole('button', { name: 'Type a move', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect.poll(() => squareKeys(page, 'square.last-move')).toEqual(['e2', 'e4']);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.locator('square.last-move:visible')).toHaveCount(0);
});

test.describe('touch board', () => {
  test.use({ hasTouch: true, viewport: { width: 390, height: 844 } });

  test('a touch at the square edge drags with legal hints on a flipped mobile board', async ({ page }, testInfo) => {
    await startLocal(page);
    await page.getByRole('button', { name: 'Flip board' }).click();
    await page.locator('cg-board').scrollIntoViewIfNeeded();
    const from = await point(page, 'e2', true, true);
    const to = await point(page, 'e4', false, true);
    const touch = await page.context().newCDPSession(page);
    await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: from.x, y: from.y }] });
    await expect.poll(() => squareKeys(page, 'square.move-dest')).toEqual(['e3', 'e4']);
    await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: to.x, y: to.y }] });
    await expect(page.locator('cg-board piece.dragging')).toBeVisible();
    await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await expect(page.getByRole('table', { name: 'Committed moves' }).getByRole('button')).toHaveCount(1);
    await expect.poll(() => squareKeys(page, 'square.last-move')).toEqual(['e2', 'e4']);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('mobile-board.png'), fullPage: true });
  });
});

test('arrow keys review positions without changing live play or text entry', async ({ page }) => {
  await startLocal(page);
  for (const coordinate of ['e2e4', 'e7e5']) {
    await expect(page.getByRole('button', { name: 'Type a move', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: 'Type a move', exact: true }).click();
    await page.getByLabel('Enter a move by coordinates').fill(coordinate);
    await page.getByRole('button', { name: 'Play move', exact: true }).click();
  }
  await expect(page.getByRole('button', { name: 'Type a move', exact: true })).toBeEnabled();
  await page.getByRole('link', { name: 'Kamkm Chess home' }).click();
  await page.keyboard.press('ArrowLeft');
  await expect(page.locator('.match-status')).toContainText('1/2');
  await expect.poll(() => squareKeys(page, 'square.last-move')).toEqual(['e2', 'e4']);
  await expect.poll(() => squareKeys(page, 'piece.black.pawn')).toContain('e7');
  await expect(page.getByRole('button', { name: 'Type a move', exact: true })).toBeDisabled();
  await expect(page.getByRole('table', { name: 'Committed moves' }).getByRole('button')).toHaveCount(2);
  await page.keyboard.press('Home');
  await expect.poll(() => squareKeys(page, 'piece.white.pawn')).toContain('e2');
  await expect(page.locator('square.last-move:visible')).toHaveCount(0);
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => squareKeys(page, 'square.last-move')).toEqual(['e2', 'e4']);
  await page.keyboard.press('End');
  await expect.poll(() => squareKeys(page, 'square.last-move')).toEqual(['e5', 'e7']);
  await expect(page.getByRole('button', { name: 'Type a move', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Type a move', exact: true }).click();
  await page.getByLabel('Enter a move by coordinates').fill('g1f3');
  await page.keyboard.press('ArrowLeft');
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.locator('.match-status')).toContainText('White to move');
  await page.getByRole('button', { name: 'View move 1: e4', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: 'View move 1: e4', exact: true })).toHaveAttribute('aria-current', 'step');
  await expect.poll(() => squareKeys(page, 'square.last-move')).toEqual(['e2', 'e4']);
  await page.getByRole('region', { name: 'Chess match board' }).getByRole('button', { name: 'Live', exact: true }).click();
  await expect.poll(() => squareKeys(page, 'square.last-move')).toEqual(['e5', 'e7']);
});

test('right-drag arrows use distinct modifier colors and right-click circles toggle', async ({ page }, testInfo) => {
  await startLocal(page);
  for (const [modifier, from, to, color] of [
    [null, 'a3', 'b4', '#15781B'],
    ['Shift', 'c3', 'd4', '#882020'],
    ['Control', 'e3', 'f4', '#003088'],
    ['Alt', 'g3', 'h4', '#e68f00'],
  ] as const) {
    const origin = await point(page, from), destination = await point(page, to);
    if (modifier) await page.keyboard.down(modifier);
    await page.mouse.move(origin.x, origin.y);
    await page.mouse.down({ button: 'right' });
    await page.mouse.move(destination.x, destination.y, { steps: 6 });
    await expect(page.locator(`.cg-shapes line[stroke="${color}"]`)).toBeVisible();
    await page.mouse.up({ button: 'right' });
    if (modifier) await page.keyboard.up(modifier);
  }
  await expect(page.locator('.cg-shapes line')).toHaveCount(4);
  const circle = await point(page, 'd5');
  await page.mouse.move(circle.x, circle.y);
  await page.mouse.down({ button: 'right' });
  await expect(page.locator('.cg-shapes circle')).toBeVisible();
  await page.mouse.up({ button: 'right' });
  await page.screenshot({ path: testInfo.outputPath('colored-arrows.png'), fullPage: true });
  await page.mouse.click(circle.x, circle.y, { button: 'right', delay: 50 });
  await expect(page.locator('.cg-shapes circle')).toHaveCount(0);
  await page.mouse.click(circle.x, circle.y);
  await expect(page.locator('.cg-shapes line')).toHaveCount(0);
  await expect(page.getByRole('table', { name: 'Committed moves' }).getByRole('button')).toHaveCount(0);
});

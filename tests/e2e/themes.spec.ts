import { expect, test } from '@playwright/test';

test.use({ reducedMotion: 'reduce' });

for (const mode of ['light', 'dark']) {
  test(`Screen preserves the original gold palette in ${mode} appearance`, async ({ page }, testInfo) => {
    await page.addInitScript(appearance => {
      localStorage.setItem('kamkmchess.theme.v1', JSON.stringify({ theme: 'screen', appearance }));
    }, mode);
    await page.goto('/');
    const tokens = await page.evaluate(() => {
      const style = getComputedStyle(document.documentElement);
      return ['canvas', 'surface', 'accent', 'accent-foreground', 'sidebar'].map(role => style.getPropertyValue('--t3-' + role).trim());
    });
    expect(tokens).toEqual(mode === 'dark'
      ? ['#000000', '#171717', '#cfbb86', '#15130e', '#111111']
      : ['#faf8f2', '#ffffff', '#cfbb86', '#15130e', '#f1ece0']);
    await page.screenshot({ path: testInfo.outputPath(`screen-${mode}-desktop.png`), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`screen-${mode}-mobile.png`), fullPage: true });
    await page.goto('/play');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'screen');
    await page.getByRole('button', { name: 'New game', exact: true }).click();
    const primary = page.locator('.button.primary').first();
    await expect(primary).toHaveCSS('background-color', 'rgb(207, 187, 134)');
    await expect(primary).toHaveCSS('color', 'rgb(21, 19, 14)');
    await page.screenshot({ path: testInfo.outputPath(`screen-${mode}-game-mobile.png`), fullPage: true });
  });
}

test('all app palettes theme the landing page in light and dark modes', async ({ page }, testInfo) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'screen');
  await expect(page.locator('html')).toHaveAttribute('data-appearance', 'dark');
  await page.screenshot({ path: testInfo.outputPath('screen-default-desktop.png'), fullPage: true });
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const theme = page.getByRole('radiogroup', { name: 'Theme' });
  const appearance = page.getByRole('radiogroup', { name: 'Appearance' });
  for (const [id, label] of [['t3-code', 'T3 Code'], ['t3-chat', 'T3 Chat'], ['screen', 'Screen'], ['grove', 'Grove'], ['ocean', 'Ocean'], ['ember', 'Ember'], ['iris', 'Iris']] as const) {
    for (const mode of ['light', 'dark']) {
      await theme.getByRole('radio', { name: label, exact: true }).locator('..').click();
      await appearance.getByRole('radio', { name: mode === 'light' ? 'Light' : 'Dark', exact: true }).locator('..').click();
      await expect(page.locator('html')).toHaveAttribute('data-theme', id);
      await expect(page.locator('html')).toHaveAttribute('data-appearance', mode);
      const colors = await page.evaluate(() => {
        const root = getComputedStyle(document.documentElement);
        const probe = document.createElement('span');
        document.body.append(probe);
        const resolve = (role: string) => {
          probe.style.color = root.getPropertyValue('--t3-' + role);
          return getComputedStyle(probe).color;
        };
        const color = (selector: string, property: 'color' | 'backgroundColor') => getComputedStyle(document.querySelector(selector)!)[property];
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 1;
        const context = canvas.getContext('2d')!;
        const luminance = (value: string) => {
          context.fillStyle = value;
          context.fillRect(0, 0, 1, 1);
          const channels = [...context.getImageData(0, 0, 1, 1).data].slice(0, 3).map(channel => {
            const part = channel / 255;
            return part <= 0.04045 ? part / 12.92 : ((part + 0.055) / 1.055) ** 2.4;
          });
          return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
        };
        const contrast = (foreground: string, background: string) => {
          const a = luminance(foreground), b = luminance(background);
          return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
        };
        const result = {
          page: color('body', 'backgroundColor'), canvas: resolve('canvas'),
          sidebar: color('.game-sidebar', 'backgroundColor'), expectedSidebar: resolve('sidebar'),
          panel: color('.landing-settings-dialog', 'backgroundColor'),
          button: color('.hero-introduction [data-slot="button"]', 'backgroundColor'), accent: resolve('accent'),
          label: color('.hero-introduction [data-slot="button"]', 'color'), accentForeground: resolve('accent-foreground'),
          contrast: {
            body: contrast(color('body', 'color'), color('body', 'backgroundColor')),
            description: contrast(color('.idea-heading p', 'color'), color('body', 'backgroundColor')),
            button: contrast(color('.hero-introduction [data-slot="button"]', 'color'), color('.hero-introduction [data-slot="button"]', 'backgroundColor')),
            select: contrast(color('.settings-tile-label', 'color'), color('.settings-tile', 'backgroundColor')),
          },
        };
        probe.remove();
        return result;
      });
      expect(colors.page, `${id} ${mode} canvas`).toBe(colors.canvas);
      expect(colors.sidebar, `${id} ${mode} sidebar`).toBe(colors.expectedSidebar);
      expect(colors.panel, `${id} ${mode} dialog`).toBe(colors.canvas);
      expect(colors.button, `${id} ${mode} action`).toBe(colors.accent);
      expect(colors.label, `${id} ${mode} action label`).toBe(colors.accentForeground);
      for (const [element, ratio] of Object.entries(colors.contrast)) {
        expect(ratio, `${id} ${mode} ${element} text contrast`).toBeGreaterThanOrEqual(4.5);
      }
    }
  }
  await page.screenshot({ path: testInfo.outputPath('iris-dark-appearance.png') });
  await page.locator('.landing-settings-dialog').getByRole('button', { name: 'Close', exact: true }).click();
  await page.screenshot({ path: testInfo.outputPath('iris-dark-desktop.png'), fullPage: true });
});

test('theme choices persist through reload and both directions of navigation', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('radiogroup', { name: 'Theme' }).getByRole('radio', { name: 'Screen', exact: true }).locator('..').click();
  await page.getByRole('radiogroup', { name: 'Appearance' }).getByRole('radio', { name: 'Dark', exact: true }).locator('..').click();
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'screen');
  await expect(page.locator('html')).toHaveAttribute('data-appearance', 'dark');
  await page.goto('/play');
  await page.getByRole('button', { name: 'New game', exact: true }).click();
  await page.locator('.right-game-sidebar').getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('radiogroup', { name: 'Theme' }).getByRole('radio', { name: 'Screen', exact: true })).toBeChecked();
  await expect(page.getByRole('radiogroup', { name: 'Appearance' }).getByRole('radio', { name: 'Dark', exact: true })).toBeChecked();
  await page.getByRole('radiogroup', { name: 'Theme' }).getByRole('radio', { name: 'Ocean', exact: true }).locator('..').click();
  await page.getByRole('radiogroup', { name: 'Appearance' }).getByRole('radio', { name: 'Light', exact: true }).locator('..').click();
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'ocean');
  await expect(page.locator('html')).toHaveAttribute('data-appearance', 'light');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('radiogroup', { name: 'Theme' }).getByRole('radio', { name: 'Ocean', exact: true })).toBeChecked();
  await expect(page.getByRole('radiogroup', { name: 'Appearance' }).getByRole('radio', { name: 'Light', exact: true })).toBeChecked();
});

test('mobile appearance follows the system and synchronizes changes from another tab', async ({ page, context }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-appearance', 'dark');
  await page.getByRole('button', { name: 'Open navigation', exact: true }).click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('radiogroup', { name: 'Theme' }).getByRole('radio', { name: 'Screen', exact: true })).toBeFocused();
  await page.getByRole('radiogroup', { name: 'Appearance' }).getByRole('radio', { name: 'System', exact: true }).locator('..').click();
  await page.getByRole('radiogroup', { name: 'Theme' }).getByRole('radio', { name: 'Ember', exact: true }).locator('..').click();
  await page.locator('.landing-settings-dialog').getByRole('button', { name: 'Close', exact: true }).click();
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(page.locator('html')).toHaveAttribute('data-appearance', 'light');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('ember-light-mobile.png'), fullPage: true });
  const other = await context.newPage();
  await other.goto('/play');
  await other.getByRole('button', { name: 'New game', exact: true }).click();
  await other.locator('.right-game-sidebar').getByRole('button', { name: 'Settings', exact: true }).click();
  await other.getByRole('radiogroup', { name: 'Theme' }).getByRole('radio', { name: 'Iris', exact: true }).locator('..').click();
  await other.getByRole('radiogroup', { name: 'Appearance' }).getByRole('radio', { name: 'Dark', exact: true }).locator('..').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'iris');
  await expect(page.locator('html')).toHaveAttribute('data-appearance', 'dark');
  await page.screenshot({ path: testInfo.outputPath('iris-dark-mobile.png'), fullPage: true });
  await other.close();
});

test('board and piece styles follow the saved choice onto every surface', async ({ page }, testInfo) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('radiogroup', { name: 'Board style' }).getByRole('radio', { name: 'Walnut', exact: true }).locator('..').click();
  await expect(page.locator('html')).toHaveAttribute('data-board-style', 'walnut');
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--board-dark').trim())).toBe('#b58863');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-board-style', 'walnut');
  await page.goto('/play');
  await expect(page.locator('html')).toHaveAttribute('data-board-style', 'walnut');
  // The board squares and the move highlights pick the palette up.
  const board = page.locator('.board-host cg-board');
  await expect(board).toBeAttached();
  await expect.poll(() => board.evaluate(element => getComputedStyle(element).backgroundImage)).toContain('rgb(181, 136, 99)');
  // Settings offers the Kamkm set; picking it swaps the artwork on the match board. Small SVGs
  // are inlined as data URLs by the production build, so the Kamkm outline colour is the marker.
  const kamkmArtwork = /(%23262019|\/pieces\/kamkm\/)/;
  await page.getByRole('button', { name: 'New game', exact: true }).click();
  await page.locator('.right-game-sidebar').getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('radiogroup', { name: 'Piece style' }).getByRole('radio', { name: 'Kamkm', exact: true }).locator('..').click();
  await expect(page.locator('.board-host')).toHaveAttribute('style', expect.stringMatching(kamkmArtwork));
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-board-style', 'walnut');
  expect(await page.locator('.board-host').getAttribute('style')).toMatch(kamkmArtwork);
  await page.screenshot({ path: testInfo.outputPath('kamkm-walnut-game.png'), fullPage: true });
});

test('unavailable storage does not prevent changing the landing theme', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'localStorage', { get() { throw new DOMException('Storage disabled', 'SecurityError'); } });
  });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'screen');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('radiogroup', { name: 'Theme' }).getByRole('radio', { name: 'Ember', exact: true }).locator('..').click();
  await page.getByRole('radiogroup', { name: 'Appearance' }).getByRole('radio', { name: 'Dark', exact: true }).locator('..').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'ember');
  await expect(page.locator('html')).toHaveAttribute('data-appearance', 'dark');
  expect(errors).toEqual([]);
});

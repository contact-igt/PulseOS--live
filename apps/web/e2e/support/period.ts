import { expect, type Page } from "@playwright/test";

// Helpers for the PulseOS period controls (a Radix select + a calendar popover), which replaced the browser-native
// <select> and <input type=date>. The trigger carries `data-value`; every option and every calendar day has a test id.

const trigger = (page: Page, prefix: string) => page.getByTestId(`${prefix}-range`);

/** Open the period menu and choose a preset by key ("7d", "custom"…; "" or "none" = the "Any date" entry). */
export async function pickPeriod(page: Page, prefix: string, key: string) {
  await trigger(page, prefix).click();
  await page.getByTestId(`${prefix}-range-option-${key || "none"}`).click();
}

/** The active preset key ("" when no period is chosen). */
export async function expectPeriod(page: Page, prefix: string, key: string) {
  await expect(trigger(page, prefix)).toHaveAttribute("data-value", key);
}

/** The labels the menu offers, in order (the menu is opened and closed again). */
export async function periodOptionLabels(page: Page, prefix: string): Promise<string[]> {
  await trigger(page, prefix).click();
  const labels = (await page.locator(`[data-testid^="${prefix}-range-option-"]`).allTextContents()).map((t) => t.trim());
  await page.keyboard.press("Escape");
  return labels;
}

/** Open the custom-range calendar, click the first and last day (paging months as needed) and Apply. */
export async function setCustomRange(page: Page, prefix: string, from: string, to: string) {
  await page.getByTestId(`${prefix}-range-picker`).click();
  const calendar = page.getByTestId(`${prefix}-calendar`);
  await expect(calendar).toBeVisible();
  const reveal = async (day: string) => {
    for (let guard = 0; guard < 36; guard++) {
      if ((await page.getByTestId(`${prefix}-day-${day}`).count()) > 0) return;
      const shown = (await calendar.getAttribute("data-month"))!;
      await page.getByTestId(`${prefix}-${day.slice(0, 7) < shown ? "prev" : "next"}-month`).click();
    }
    throw new Error(`could not page the calendar to ${day}`);
  };
  await reveal(from);
  await page.getByTestId(`${prefix}-day-${from}`).click();
  await reveal(to);
  await page.getByTestId(`${prefix}-day-${to}`).click();
  await page.getByTestId(`${prefix}-apply`).click();
  await expect(page.getByTestId(`${prefix}-range-popover`)).toHaveCount(0);
}

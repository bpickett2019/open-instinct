import { test as base, expect, type Page, type TestInfo } from "@playwright/test";
import { createScenarioApp, type ScenarioApp, type ScenarioOptions } from "../testing/scenario-app.js";
import { evidenceCases, type EvidenceCaseId, type EvidenceCheckpoint } from "./evidence-manifest.js";
export const test = base.extend<{ scenarioOptions: ScenarioOptions; scenario: ScenarioApp; login: () => Promise<void>; checkpoint: (id: EvidenceCaseId, theme: "light" | "dark") => Promise<void>; privateFailureCapture: void }>({
  scenarioOptions: [{}, { option: true }],
  privateFailureCapture: [async ({ page, scenario: _scenario }, use, info) => {
    await use();
    if (info.status !== info.expectedStatus) {
      // A failure can occur while credentials are still in a regular text field.
      // Trace DOM is sanitized separately; no raw screencast pixels are published.
      const path = info.outputPath("test-failed-private-safe.png");
      await page.screenshot({ path, fullPage: true, mask: [page.locator("input, textarea, [data-sensitive]")] });
      await info.attach("failure-screenshot", { path, contentType: "image/png" });
    }
  }, { auto: true }],
  scenario: async ({ context, scenarioOptions }, use) => {
    const scenario = await createScenarioApp(scenarioOptions); const violations: string[] = [];
    await context.route("**/*", async route => {
      const url = new URL(route.request().url());
      if (!["http:", "https:"].includes(url.protocol)) { await route.continue(); return; }
      if (!scenario.allowedOrigins.has(url.origin)) { violations.push(`${url.origin}${url.pathname}`); await route.abort("blockedbyclient"); return; }
      await route.continue();
    });
    try { await use(scenario); }
    finally { await scenario.close(); expect(violations, "Browser attempted nonfixture traffic").toEqual([]); }
  },
  login: async ({ page, scenario }, use) => { await use(async () => { await page.goto(`${scenario.url}/workspace`); await page.getByLabel("Workspace token").fill(scenario.token); await page.getByRole("button", { name: "Sign in", exact: true }).click(); await expect(page.getByRole("button", { name: "Stop all work", exact: true })).toBeVisible(); await expect(page.locator(".loading")).toHaveCount(0); await expect(page.locator("#messages")).toContainText("Welcome. Tell me about your business and what you would like help with."); }); },
  checkpoint: async ({ page, scenario }, use, testInfo) => { await use(async (id, theme) => capture(page, scenario, testInfo, id, theme)); },
});
export { expect };
async function capture(page: Page, scenario: ScenarioApp, info: TestInfo, id: EvidenceCaseId, theme: "light" | "dark"): Promise<void> {
  const entry = evidenceCases.find(c => c.id === id)!;
  await expect(page.locator(".loading")).toHaveCount(0);
  await expect(page.locator("h1")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "Workspace must not overflow horizontally").toBe(true);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForFunction(() => window.scrollY === 0);
  const screenshotPath = info.outputPath(`${id}-${theme}.png`);
  await page.screenshot({ path: screenshotPath, fullPage: true });
  await info.attach(`${id}-${theme}`, { path: screenshotPath, contentType: "image/png" });
  const store = scenario.app.business!.coordinator.store;
  const checkpoint: EvidenceCheckpoint = { caseId: id, route: new URL(page.url()).hash || "/workspace", state: entry.state, viewport: info.project.name as "desktop" | "mobile", theme, fixtureId: `synthetic-${info.testId}`, assertions: entry.assertions, screenshotPath, taskIds: store.tasks().map(t => t.id), actionIds: store.actions().map(a => a.id), verificationMode: "emulated" };
  await info.attach(`checkpoint-${id}-${theme}`, { body: Buffer.from(JSON.stringify(checkpoint)), contentType: "application/vnd.instinct.evidence+json" });
}
export async function assertAllowances(page: Page, scenario: ScenarioApp): Promise<void> {
  const balances = scenario.app.business!.coordinator.store.allowanceBalances();
  for (const path of ["/overview", "/settings"]) {
    const response = await scenario.owner(path); expect(response.status).toBe(200);
    expect((await response.json() as { allowances: unknown }).allowances).toEqual(balances);
  }
  for (const kind of ["purchase", "model"] as const) {
    const balance = balances[kind]; const units = kind === "model" ? "USD cents" : `${balance.currency} minor units`;
    const panel = page.locator(`[data-allowance="${kind}"]`);
    await expect(panel.locator("dt")).toHaveText(["Accounted", "Held", "Limit", "Remaining"]);
    await expect(panel.locator("dd")).toHaveText([
      `${balance.usedMinor} ${units}`, `${balance.heldMinor} ${units}`,
      balance.limitMinor === null ? "Unconfigured (no owner cap)" : `${balance.limitMinor} ${units}`,
      balance.unknown ? "Unknown (usage or pricing unavailable)" : balance.remainingMinor === null ? "Unconfigured (no owner cap)" : `${balance.remainingMinor} ${units}`,
    ]);
    if (balance.unknown) await expect(panel).toContainText("unknown, not free");
  }
}
export async function navigate(page: Page, route: string, heading: string): Promise<void> {
  await page.evaluate(route => { location.hash = route; }, route);
  await expect(page.getByRole("heading", { level: 1, name: heading, exact: true })).toBeVisible();
  await expect(page.locator(".loading")).toHaveCount(0);
}

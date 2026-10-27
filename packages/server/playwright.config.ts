import { defineConfig } from "@playwright/test";
const suffix = process.env.INSTINCT_EVIDENCE_NEGATIVE_CASE === "1" ? "-negative" : "";
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: Boolean(process.env.CI),
  timeout: 60_000,
  expect: { timeout: 10_000 },
  outputDir: `test-results${suffix}`,
  reporter: [["./e2e/evidence-reporter.ts"], ["list"], ["html", { outputFolder: `playwright-report${suffix}`, open: "never" }], ["json", { outputFile: `playwright-report${suffix}/results.json` }]],
  use: { browserName: "chromium", locale: "en-US", timezoneId: "UTC", colorScheme: "light", video: "off", trace: "retain-on-failure", screenshot: "off", serviceWorkers: "block" },
  projects: [
    { name: "desktop", use: { viewport: { width: 1440, height: 1000 } } },
    { name: "mobile", use: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
  ],
});

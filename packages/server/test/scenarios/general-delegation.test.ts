import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import ExcelJS from "exceljs";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { fauxAssistantMessage, type FauxResponseStep } from "@earendil-works/pi-ai";
import { createScenarioApp, type ScenarioApp } from "../../testing/scenario-app.js";
import { finishFromEvidence, toolCall as call, toolResult as result } from "../../testing/document-lifecycle.js";
import { record } from "../../testing/emulators/http.js";
import type { ArtifactRecord, KnowledgeSource } from "../../src/business-knowledge-types.js";

const instances: ScenarioApp[] = [];
afterEach(async () => { for (const scenario of instances.splice(0).reverse()) await scenario.close(); });
const xlsxMime = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const hostedPath = "/data/supplier-comparison.xlsx";
const officeDisclosure = "Office execution is emulated; cached formula results are not recalculated.";
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

// Only provider inputs and model decisions are controlled. PDF rendering, hosted transfer,
// extraction, task dispatch, admission, artifact downloads and completion are production code.
// ExcelJS supplies the emulated office output. No shell or LibreOffice execution is claimed.
describe.sequential("General business delegation (emulated)", () => {
  it("G1/G4/G8: prepares a cited client brief and supplier workbook through the generic durable runtime", async () => {
    const s = await createScenarioApp({ responses: [], now: () => new Date("2026-10-23T09:00:00Z") });
    instances.push(s);
    await s.login();
    const uploaded = await s.owner("/knowledge", { method: "POST", body: {
      filename: "supplier-research.txt", mimeType: "text/plain", authoritative: false,
      base64: Buffer.from("Cedar Supply: unit USD 18.50; lead 3 days.\nHarbor Supply: unit USD 21.25; lead 1 day.\nShipping included. Tax treatment not established. Research snapshot, not a purchase authorization.").toString("base64"),
    } });
    expect(uploaded.status).toBe(201);
    const source = record(await uploaded.json());
    const sourceId = String(source.id);
    const client = await s.providers.google.importMessage(Buffer.from([
      "From: client@fixture.test", "To: owner@fixture.test", "Subject: Discovery meeting preparation",
      "Date: Fri, 23 Oct 2026 08:00:00 +0000", "Message-ID: <client-brief@fixture.test>", "",
      "We need 12 sample kits. Compare cost and lead time before our discovery meeting. Do not order anything.",
    ].join("\r\n")).toString("base64url"));
    const event = {
      id: "clientdiscovery23", etag: '"fixture-seeded-discovery"', status: "confirmed",
      summary: "Client discovery meeting", location: "Synthetic video room",
      start: { dateTime: "2026-10-26T14:00:00Z", timeZone: "UTC" },
      end: { dateTime: "2026-10-26T14:30:00Z", timeZone: "UTC" }, attendees: [{ email: "client@fixture.test" }],
    };
    s.providers.calendar.events.set(event.id, structuredClone(event));
    const store = s.app.business!.coordinator.store;
    const workspaceId = store.settings().value.workspaceId;
    let quantity = 0, meeting = "", citation = "", pdfId = "", workbookId = "";
    let officeBytes = Buffer.alloc(0), pdfMarkdown = "", expectedText: string[] = [];
    const supplierRows: Array<{ name: string; unit: number; days: number; total: number }> = [];
    let scriptFailure: unknown;

    const responses: FauxResponseStep[] = [
      call("business_google", { operation: "message", input: { id: client.id } }),
      transcript => {
        const mail = result(transcript, "business_google");
        expect(mail.id).toBe(client.id);
        const payload = record(mail.payload);
        const text = Buffer.from(String(record(payload.body).data), "base64url").toString("utf8");
        expect(text).toContain("Do not order anything");
        quantity = Number(/need (\d+) sample kits/.exec(text)?.[1]);
        expect(quantity).toBe(12);
        return call("business_google", { operation: "event", input: { id: event.id } });
      },
      transcript => {
        const actual = result(transcript, "business_google");
        expect(actual).toMatchObject(event);
        meeting = `${actual.summary}: ${record(actual.start).dateTime} (UTC)`;
        return call("knowledge_source", { id: sourceId });
      },
      async transcript => {
        const cited = result(transcript, "knowledge_source");
        expect(cited).toMatchObject({ id: sourceId, authority: "evidence", obsolete: false });
        const chunks = (cited.chunks as unknown[]).map(record);
        expect(chunks.every(chunk => chunk.current === true)).toBe(true);
        citation = `knowledge:${sourceId} v${cited.sourceVersion} ${chunks.map(chunk => chunk.locator).join(", ")}`;
        const research = chunks.map(chunk => String(chunk.text)).join("\n");
        for (const match of research.matchAll(/(Cedar Supply|Harbor Supply): unit USD (\d+\.\d{2}); lead (\d+) days?/g)) {
          const unit = Number(match[2]);
          supplierRows.push({ name: match[1]!, unit, days: Number(match[3]), total: Math.round(unit * 100) * quantity / 100 });
        }
        expect(supplierRows).toEqual([
          { name: "Cedar Supply", unit: 18.5, days: 3, total: 222 },
          { name: "Harbor Supply", unit: 21.25, days: 1, total: 255 },
        ]);
        const comparison = supplierRows.map(row => `${row.name}: ${quantity} x USD ${row.unit.toFixed(2)} = USD ${row.total.toFixed(2)}; lead ${row.days} ${row.days === 1 ? "day" : "days"}.`);
        const savings = supplierRows[1]!.total - supplierRows[0]!.total;
        pdfMarkdown = [
          meeting, "", `Client needs ${quantity} sample kits.`, "", ...comparison, "",
          `Cedar Supply saves USD ${savings.toFixed(2)}; Harbor Supply is 2 days faster.`, "",
          "Recommendation: discuss the cost-versus-speed tradeoff at the meeting. No order placed. Tax treatment remains unconfirmed.", "",
          `Research: ${citation}`, "", `Client request: gmail:${client.id}`, "", `Meeting: calendar:${event.id}`, "", officeDisclosure,
        ].join("\n");
        expectedText = ["Client discovery brief", "12 sample kits", "222.00", "255.00", "33.00", sourceId, `gmail:${client.id}`, `calendar:${event.id}`];

        // Independently stored synthetic provider file, not an application receipt or a fake tool result.
        const workbook = new ExcelJS.Workbook();
        workbook.creator = "Synthetic office emulator";
        const sheet = workbook.addWorksheet("Suppliers");
        sheet.addRow(["Supplier", "Quantity", "Unit USD", "Total USD", "Lead days", "Source citation"]);
        supplierRows.forEach((row, index) => sheet.addRow([
          row.name, quantity, row.unit, { formula: `B${index + 2}*C${index + 2}`, result: row.total }, row.days, citation,
        ]));
        sheet.addRow(["Cedar savings USD", null, null, { formula: "D3-D2", result: savings }]);
        sheet.getColumn(3).numFmt = "0.00";
        sheet.getColumn(4).numFmt = "0.00";
        [24, 12, 12, 12, 12, 78].forEach((width, index) => { sheet.getColumn(index + 1).width = width; });
        sheet.getRow(1).font = { bold: true };
        sheet.getColumn(6).alignment = { wrapText: true, vertical: "top" };
        sheet.getRow(2).height = 36;
        sheet.getRow(3).height = 36;
        const context = workbook.addWorksheet("Context");
        context.addRow(["Client request", `gmail:${client.id}`]);
        context.addRow(["Meeting", `calendar:${event.id}`, meeting]);
        context.addRow(["Research", citation]);
        context.addRow(["Execution boundary", officeDisclosure]);
        context.addRow(["Commercial boundary", "No order placed; tax treatment unconfirmed"]);
        [26, 100, 76].forEach((width, index) => { context.getColumn(index + 1).width = width; });
        context.eachRow(row => { row.alignment = { wrapText: true, vertical: "top" }; row.height = 36; });
        officeBytes = Buffer.from(await workbook.xlsx.writeBuffer());
        return call("create_pdf", { path: "client-brief.pdf", title: "Client discovery brief", markdown: pdfMarkdown });
      },
      () => call("artifact_register", { path: "client-brief.pdf", mimeType: "application/pdf", expectedText }),
      transcript => {
        pdfId = String(result(transcript, "artifact_register").id);
        return call("get_computer", {});
      },
      transcript => {
        const computer = s.providers.maritime.computers.get(workspaceId)!;
        expect(result(transcript, "get_computer").computer_id).toBe(computer.id);
        computer.files.set(hostedPath, { encoding: "base64", data: officeBytes.toString("base64"), bytes: officeBytes.length, sha256: sha256(officeBytes), mime: xlsxMime });
        return call("computer_import_artifact", { path: hostedPath, filename: "supplier-comparison.xlsx", mimeType: xlsxMime,
          expectedText: ["Cedar Supply", "Harbor Supply", "222", "255", "33", "B2*C2", "D3-D2", "cached result unverified", sourceId, officeDisclosure] });
      },
      transcript => {
        const imported = result(transcript, "computer_import_artifact");
        workbookId = String(imported.artifactId);
        expect(imported).toMatchObject({ sha256: sha256(officeBytes), bytes: officeBytes.length, evidenceLevel: "document-readback" });
        return finishFromEvidence(s,
          `Prepared client brief artifact:${pdfId} and supplier comparison artifact:${workbookId}. Cedar USD 222.00 versus Harbor USD 255.00 for 12 kits; saving USD 33.00 versus two days faster. Sources: ${citation}; gmail:${client.id}; calendar:${event.id}. ${officeDisclosure} No order placed; tax treatment unconfirmed.`,
          ["artifact_register", "computer_import_artifact"]);
      },
      fauxAssistantMessage("The source-linked brief and comparison files are ready. Office execution was emulated, not a real LibreOffice run."),
    ];
    s.model.setResponses(responses.map<FauxResponseStep>(step => {
      if (typeof step !== "function") return step;
      return async (...args) => {
        try { return await step(...args); }
        catch (error) { scriptFailure = error; throw error; }
      };
    }));
    const objective = "Prepare a client discovery brief from the client's email and calendar meeting, compare the supplied supplier research, and leave a cited PDF plus spreadsheet in Files. Do not email, book, buy or place an order.";
    expect((await s.postMessage(objective)).status).toBe(202);
    await s.waitFor(() => {
      if (scriptFailure) throw scriptFailure;
      return store.tasks().some(task => task.status === "completed") && s.app.runtime.stats().busy === 0;
    }, "general delegation artifact completion", 20000);
    expect(store.tasks()).toHaveLength(1);
    const task = store.tasks()[0]!;
    expect(task).toMatchObject({ objective, status: "completed", origin: { requester: "owner", audience: "owner" } });
    expect(store.get<{ kind: string; enabled: boolean }>("authority", task.authorityRef)?.value).toMatchObject({ kind: "owner", enabled: true });
    expect(task.evidenceRefs).toEqual(expect.arrayContaining([`artifact:${pdfId}`, `artifact:${workbookId}`]));
    expect(task.result).toContain(citation);
    expect(task.result).toContain(officeDisclosure);
    const actions = store.actions(task.id);
    for (const tool of ["create_pdf", "artifact_register", "computer_import_artifact"]) {
      const action = actions.find(action => action.tool === tool)!;
      expect(action).toMatchObject({ status: "verified", effectful: true });
      expect(action.sourceRevisions[`knowledge:${sourceId}`]).toBe(store.get("knowledge", sourceId)!.version);
    }
    expect(actions.filter(action => action.tool === "business_google")).toHaveLength(2);
    expect(actions.filter(action => action.tool === "business_google").every(action => action.status === "verified" && !action.effectful)).toBe(true);
    expect(s.providers.google.accepted).toHaveLength(0);
    expect([...s.providers.calendar.events.values()]).toEqual([event]);
    expect(s.providers.calendar.journal.some(entry => entry.method === "GET" && entry.path.endsWith(`/events/${event.id}`))).toBe(true);
    expect(s.providers.maritime.invocations.filter(entry => entry.name === "read_file").map(entry => entry.args.path)).toEqual([hostedPath]);
    expect(s.providers.maritime.invocations.some(entry => entry.name === "shell")).toBe(false);

    const downloads = new Map<string, Buffer>();
    for (const [id, filename, mimeType] of [[pdfId, "client-brief.pdf", "application/pdf"], [workbookId, "supplier-comparison.xlsx", xlsxMime]]) {
      expect((await s.fetch(`${s.url}/api/owner/files/${id}/download`)).status).toBe(401);
      const response = await s.owner(`/files/${id}/download`);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe(mimeType);
      expect(response.headers.get("content-disposition")).toContain(`attachment; filename="${filename}"`);
      const bytes = Buffer.from(await response.arrayBuffer());
      downloads.set(id!, bytes);
      const artifact = store.get<ArtifactRecord>("artifact", id!)!.value;
      expect(artifact).toMatchObject({ filename, mimeType, extraction: "ready", source: "generated", authority: "evidence", sha256: sha256(bytes), size: bytes.length, taskIds: [task.id] });
    }
    const pdf = downloads.get(pdfId)!;
    expect(pdf).toEqual(await readFile(join(s.root, "workspace", "client-brief.pdf")));
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    const parser = getDocument({ data: Uint8Array.from(pdf), useSystemFonts: false, disableFontFace: true });
    try {
      const document = await parser.promise;
      const pages: string[] = [];
      for (let index = 1; index <= document.numPages; index++) {
        const page = await document.getPage(index);
        const content = await page.getTextContent();
        pages.push(content.items.map(item => "str" in item ? item.str : "").join(" "));
        page.cleanup();
      }
      const text = pages.join(" ").replace(/\s+/g, " ");
      for (const expected of [...expectedText, "Cedar Supply", "Harbor Supply", "18.50", "21.25", event.start.dateTime, "Tax treatment remains unconfirmed"]) expect(text).toContain(expected);
    } finally { await parser.destroy(); }

    const xlsx = downloads.get(workbookId)!;
    expect(xlsx).toEqual(officeBytes);
    const reopened = new ExcelJS.Workbook();
    await reopened.xlsx.load(xlsx as unknown as Parameters<typeof reopened.xlsx.load>[0]);
    const sheet = reopened.getWorksheet("Suppliers")!;
    expect(sheet.getRow(2).values).toEqual([undefined, "Cedar Supply", 12, 18.5, { formula: "B2*C2", result: 222 }, 3, citation]);
    expect(sheet.getRow(3).values).toEqual([undefined, "Harbor Supply", 12, 21.25, { formula: "B3*C3", result: 255 }, 1, citation]);
    expect(sheet.getCell("D4").value).toEqual({ formula: "D3-D2", result: 33 });
    expect(sheet.getCell("D2").numFmt).toBe("0.00");
    expect(reopened.getWorksheet("Context")!.getCell("B1").value).toBe(`gmail:${client.id}`);
    expect(reopened.getWorksheet("Context")!.getCell("B2").value).toBe(`calendar:${event.id}`);
    expect(reopened.getWorksheet("Context")!.getCell("B4").value).toBe(officeDisclosure);
    const workbookSource = store.get<KnowledgeSource>("knowledge", workbookId)!.value;
    expect(workbookSource.sourceLocator).toBe(`task:${task.id}:hosted-file:${encodeURIComponent(hostedPath)}`);
    expect(workbookSource.chunks.find(chunk => chunk.locator === "sheet:Suppliers:row:2")?.text).toContain("formula B2*C2; cached result unverified: 222");
    const files = record(await (await s.owner("/files")).json()).artifacts as Array<{ id: string }>;
    expect(files.map(file => file.id)).toEqual(expect.arrayContaining([sourceId, pdfId, workbookId]));

    // Persistence is checked through a fresh production boot, not by directly completing a store row.
    const evidence = task.evidenceRefs;
    const actionIds = actions.map(action => action.id);
    await s.restart();
    await s.login();
    const recovered = s.app.business!.coordinator.store;
    expect(recovered.task(task.id)).toMatchObject({ status: "completed", result: task.result, evidenceRefs: evidence });
    expect(recovered.actions(task.id).map(action => action.id)).toEqual(actionIds);
    for (const [id, bytes] of downloads) {
      const response = await s.owner(`/files/${id}/download`);
      expect(response.status).toBe(200);
      expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
    }
    const messages = JSON.stringify(await (await s.owner("/messages")).json());
    for (const reference of [task.id, pdfId, workbookId, sourceId, `gmail:${client.id}`, `calendar:${event.id}`]) expect(messages).toContain(reference);
    const evidenceDirectory = process.env.INSTINCT_SCENARIO_EVIDENCE_DIR;
    if (evidenceDirectory) {
      await mkdir(evidenceDirectory, { recursive: true });
      await writeFile(join(evidenceDirectory, "general-client-brief.pdf"), pdf);
      await writeFile(join(evidenceDirectory, "supplier-comparison.xlsx"), xlsx);
      await writeFile(join(evidenceDirectory, "proof.json"), JSON.stringify({
        verificationMode: "emulated",
        officeExecution: officeDisclosure,
        taskId: task.id,
        sourceId,
        citation,
        providerSources: { gmailMessageId: client.id, calendarEventId: event.id },
        actionIds,
        artifacts: [
          { id: pdfId, filename: "general-client-brief.pdf", sha256: sha256(pdf), bytes: pdf.length },
          { id: workbookId, filename: "supplier-comparison.xlsx", sha256: sha256(xlsx), bytes: xlsx.length },
        ],
        checkedFigures: { quantity, suppliers: supplierRows, savingsUsd: 33 },
        evidenceRefs: evidence,
        taskStatusAfterRestart: recovered.task(task.id)!.status,
        notProved: ["Live provider authentication", "LibreOffice execution", "Spreadsheet formula recalculation", "A purchase or customer communication"],
      }, null, 2));
    }
  }, 30000);
});

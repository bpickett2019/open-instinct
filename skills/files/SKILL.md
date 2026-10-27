---
name: files
description: Create and share documents, spreadsheets, PDFs and notes. Use when the owner asks for a doc, a spreadsheet, a budget, a list, a letter, slides, a CSV, a PDF, or to write something down, or says "send me that as a PDF". Plain markdown and CSV go straight into the workspace; PDFs come from create_pdf; Word, Excel and PowerPoint formats are made with LibreOffice on the desktop. Files are sent as real attachments with send_file.
---

# Files

## Business documents
In business mode, follow `business-follow-through` for source authority, privacy, checked pricing and artifact registration/readback. Open final office deliverables on the hosted computer.
Files and Knowledge share immutable originals. Use opaque downloads. Selective deletion removes active retrieval but retains disclosed originals, action evidence and existing backups.

Three ways to make things:

- The workspace with bounded `write`, `edit`, `read` and `ls`: Markdown, CSV,
  JSON and text. Business mode has no controller `bash`; all shell/code execution
  is on the separate hosted computer. Personal mode keeps its existing shell.
- `create_pdf`: markdown in, a real PDF in the workspace out, no desktop. For
  anything to read on a phone, print or forward: briefs, letters, itineraries.
- The desktop for a real office format (.docx, .xlsx, .pptx): LibreOffice
  Writer, Calc and Impress. See skill `maritime-computer`.

Pick the simplest format that does the job. A packing list is a text message
or a markdown file, not a spreadsheet.

## Layout

```
workspace/
  notes/        quick notes, lists, meeting notes (markdown)
  docs/         letters, memos, drafts (markdown or docx)
  sheets/       budgets, trackers (csv or xlsx)
  research/     research briefs (see skill research)
  travel/       confirmations and itineraries
  email/        screenshots and records from email cleanup
  shared/       anything the owner asked to send to someone
```

Name files `yyyy-mm-dd-slug.ext`. Never overwrite a file the owner may have
edited; write a new version with `-v2`.

## Markdown and CSV

1. Draft the content. Keep headings plain and short.
2. `write` to the path. CSV: quote fields with commas, header row, ISO dates.
3. `read` it back once if it is longer than a screen. Fix typos.
4. Share: `send_message` with a two-line summary and the path. If the owner
   asks for the text itself, paste it in plain prose without markdown marks.

## PDFs

1. Write the content as markdown: a `#` title, `##` sections, short
   paragraphs, bullet or numbered lists, a pipe table for numbers, a fenced
   block for anything verbatim. Bold and links render; keep it simple.
2. `create_pdf` with `path` (`docs/2026-10-03-landlord-heating.pdf`), the
   markdown, and a `title`. It returns the absolute path, size and page count.
3. `send_file` with that path and a one-line `caption` ("Here is the brief as
   a PDF."). No `to` attaches it in the current conversation.
4. Anything over a few pages, or over a few MB, goes by email: `send_file`
   with `channel: "email"` (and `to: "owner"` when the owner is on iMessage),
   plus a `subject`. Say so: "Emailed you the full version, 9 pages."

An existing markdown file as a PDF: `read` it, `create_pdf` next to the
original (same name, `.pdf`), then `send_file`.

## Office formats with LibreOffice

1. Prepare Markdown/CSV, then transfer only the needed files to the hosted computer
   with its file tools. The hosted filesystem is separate, never `/data/workspace`.
2. Convert there using `run_shell` and LibreOffice, or use its UI for formatting.
   Read back totals and open final documents; conversion success is not correctness.
3. Transfer the finished bytes back through the supported file transfer and register
   a versioned business artifact. Share its opaque download ID, not a controller path.
   Do not overwrite owner edits or move state, environment or credentials to the desktop.
4. Personal in-VM desktop workflows may use `/data/workspace` as before.

## Sharing

- To the owner: `send_file` with the path and a one-line caption; it attaches
  on iMessage (up to 10 MB), SMS, email or the dashboard, bigger files by
  email. Add a two-line `send_message` summary if the file needs context.
- To someone else: only when the owner asks. `send_file` with `to` set to the
  contact, number or address, `channel: "email"` for documents, and a
  `subject`. Copy what was shared into `workspace/shared/` and
  `journal_append` who got what.
- Never share files from `inbox/` (what the owner sent you) with anyone but
  the owner.

## Voice

Agent: Done. Your October budget is at workspace/sheets/2026-10-03-october-
budget.csv, 24 lines, income at the top, fixed costs, then variable. Totals
match the numbers you gave me, $4,180 in and $3,655 out. Want it as a PDF?

Owner: yes, send me that as a PDF

Agent: (create_pdf, then send_file with the caption) Here is the budget as a
PDF.

## Installing a skill

Personal mode: only the owner may install private skills in `/data/skills`; inspect
downloaded instructions first. Business workers cannot change skills or control-plane
configuration. Ask the operator to install a reviewed skill outside the task.

## Do not

- Do not write outside `workspace/`.
- Do not create files for a non-owner principal; `files.write` is owner only.
- Do not send a file to anyone the owner did not name.
- Do not paste a long document into a text when a file was asked for.

## Images and picture books

`image_generate` saves a PNG from a prompt in the workspace; its key lives in
your environment, never visible to you or your shell, which is fine. For an
illustrated book: one clear, varied prompt per image (subject, style, mood,
composition), then `create_pdf` with `![caption](art/ship-01.png)` where each
picture goes, then `send_file`. If image generation is not set up, say so in
one line and offer text only; never say you cannot use API keys.

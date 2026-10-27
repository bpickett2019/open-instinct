import { copyFile, mkdir } from "node:fs/promises";
const destination = new URL("../dist/web/", import.meta.url);
await mkdir(destination, { recursive: true });
await copyFile(new URL("../web/workspace.css", import.meta.url), new URL("workspace.css", destination));

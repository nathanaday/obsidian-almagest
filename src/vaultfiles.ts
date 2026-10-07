import { App, TFile, Vault } from "obsidian";

/** The markdown files under one folder of the vault, read without listing the rest of it. */
export function markdownFilesIn(app: App, folder: string): TFile[] {
	const root = app.vault.getFolderByPath(folder.replace(/\/+$/, ""));
	if (!root) return [];
	const out: TFile[] = [];
	Vault.recurseChildren(root, (file) => {
		if (file instanceof TFile && file.extension === "md") out.push(file);
	});
	return out;
}

import { App, Component, type FrontMatterCache, MarkdownRenderer, MarkdownView, Notice, TFile } from "obsidian";
import type { PageSizeType, ExportConfigType } from "./modal";
import { copyAttributes, fixAnchors, modifyDest } from "./utils";
import * as electron from "electron";

export type ExportTheme = "light" | "dark";

// Theme applied to exported documents. "light" preserves the original
// behavior; "dark" keeps the vault's dark styling in the PDF.
let currentExportTheme: ExportTheme = "light";

export function setExportTheme(theme: ExportTheme) {
  currentExportTheme = theme;
}

export function getExportTheme(): ExportTheme {
  return currentExportTheme;
}

const PRINT_PAGE_BACKGROUND_STYLE_ID = "better-export-pdf-page-background";

/**
 * Fill the printed page box for dark exports. Unlike styling the rendered
 * note, @page also covers the sheet area exposed by print margins, which
 * would otherwise stay white. Returns the style element (caller removes it
 * after printing), or null for light exports.
 */
export function applyPrintPageBackgroundStyle(themeRoot: HTMLElement, theme: ExportTheme): HTMLStyleElement | null {
  const doc = themeRoot.ownerDocument;
  doc.getElementById(PRINT_PAGE_BACKGROUND_STYLE_ID)?.remove();
  if (theme !== "dark") return null;

  const probe = doc.createElement("span");
  probe.style.cssText = "position:fixed;visibility:hidden;background-color:var(--background-primary, #1e1e1e)";
  // Resolve the variable inside the exported element. The Obsidian window may
  // itself be light while a dark export is requested, so probing document.body
  // can incorrectly resolve --background-primary to white.
  themeRoot.appendChild(probe);
  const pageColor = doc.defaultView?.getComputedStyle(probe).backgroundColor ?? "#1e1e1e";
  probe.remove();

  const style = doc.createElement("style");
  style.id = PRINT_PAGE_BACKGROUND_STYLE_ID;
  style.media = "print";
  style.textContent = `@page { background-color: ${pageColor} !important; }`;
  doc.head.appendChild(style);
  return style;
}

const PRINT_THEME_STYLE_ID = "better-export-pdf-print-theme";

/**
 * Paint the exported note's background. The `.print` root and its markdown view
 * have no background-color of their own (transparent), so a dark export would
 * render as a white page with invisible (white) text — printBackground has
 * nothing to paint. Set background/text from --background-primary/--text-normal,
 * which resolve to the correct theme because document.body is swapped to the
 * export theme during printing. Caller removes the returned style after printing.
 */
export function applyPrintThemeStyle(themeRoot: HTMLElement, theme: ExportTheme): HTMLStyleElement {
  const doc = themeRoot.ownerDocument;
  doc.getElementById(PRINT_THEME_STYLE_ID)?.remove();
  const style = doc.createElement("style");
  style.id = PRINT_THEME_STYLE_ID;
  style.textContent = `
    .print.theme-${theme},
    .print.theme-${theme} .markdown-preview-view,
    .print.theme-${theme} .markdown-rendered {
      background-color: var(--background-primary);
      color: var(--text-normal);
    }
  `;
  doc.head.appendChild(style);
  return style;
}

export function getAllStyles() {
  const cssTexts: string[] = [];

  Array.from(document.styleSheets).forEach((sheet) => {
    // @ts-ignore
    const id = sheet.ownerNode?.id;

    // <style id="svelte-xxx" ignore
    if (id?.startsWith("svelte-")) {
      return;
    }
    // @ts-ignore
    const href = sheet.ownerNode?.href;

    const division = `/* ----------${id ? `id:${id}` : href ? `href:${href}` : ""}---------- */`;

    cssTexts.push(division);

    try {
      Array.from(sheet?.cssRules ?? []).forEach((rule) => {
        cssTexts.push(rule.cssText);
      });
    } catch (error) {
      console.error(error);
    }
  });

  cssTexts.push(...getPatchStyle());
  return cssTexts;
}

const CSS_PATCH = `
/* ---------- css patch ---------- */

body {
  overflow: auto !important;
}
@media print {
  .print .markdown-preview-view {
    height: auto !important;
  }
  .md-print-anchor, .blockid {
    white-space: pre !important;
    border-left: none !important;
    border-right: none !important;
    border-top: none !important;
    border-bottom: none !important;
    display: inline-block !important;
    position: absolute !important;
    width: 1px !important;
    height: 1px !important;
    right: 0 !important;
    outline: 0 !important;
    background: 0 0 !important;
    text-decoration: initial !important;
    text-shadow: initial !important;
  }
}
@media print {
  table {
    break-inside: auto;
  }
  tr {
    break-inside: avoid;
    break-after: auto;
  }
}

img.__canvas__ {
  width: 100% !important;
  height: 100% !important;
}
`;

export function getPatchStyle() {
  return [CSS_PATCH, ...getPrintStyle()];
}

export function getPrintStyle() {
  const cssTexts: string[] = [];
  Array.from(document.styleSheets).forEach((sheet) => {
    try {
      const cssRules = sheet?.cssRules ?? [];
      Array.from(cssRules).forEach((rule) => {
        if (rule.constructor.name == "CSSMediaRule") {
          if ((rule as CSSMediaRule).conditionText === "print") {
            const res = rule.cssText.replace(/@media print\s*\{(.+)\}/gms, "$1");
            cssTexts.push(res);
          }
        }
      });
    } catch (error) {
      console.error(error);
    }
  });
  return cssTexts;
}

export function generateDocId(n: number) {
  return Array.from({ length: n }, () => ((16 * Math.random()) | 0).toString(16)).join("");
}

export type AyncFnType = (...args: unknown[]) => Promise<unknown>;

export function getFrontMatter(app: App, file: TFile) {
  const cache = app.metadataCache.getFileCache(file);
  return cache?.frontmatter ?? ({} as FrontMatterCache);
}

export type ParamType = {
  app: App;
  file: TFile;
  config?: ExportConfigType;
  exportTheme?: ExportTheme;
  extra?: {
    title?: string;
    file: TFile;
    id?: string;
  };
  cleanup?: () => void;
};

// 逆向Obdian官方打印函数
export async function renderMarkdown({
  app,
  file,
  config,
  extra,
  exportTheme = currentExportTheme,
}: ParamType) {
  const startTime = new Date().getTime();

  const ws = app.workspace;
  // if (ws.getActiveFile()?.path != file.path) {
  //   const leaf = ws.getLeaf(true);
  //   console.debug(file, leaf);
  //   await leaf.openFile(file);
  // }
  // const view = ws.getActiveViewOfType(MarkdownView) as MarkdownView;

  const leaf = ws.getLeaf(true);
  await leaf.openFile(file);
  const view = leaf.view as MarkdownView;
  const data = await app.vault.cachedRead(file);
  if (!data) {
    new Notice("data is empty!");
  }

  const frontMatter = getFrontMatter(app, file);

  const cssclasses = [];
  for (const [key, val] of Object.entries(frontMatter)) {
    if (key.toLowerCase() == "cssclass" || key.toLowerCase() == "cssclasses") {
      if (Array.isArray(val)) {
        cssclasses.push(...val);
      } else {
        cssclasses.push(val);
      }
    }
  }

  const comp = new Component();
  comp.load();

  const printEl = document.body.createDiv(`print theme-${exportTheme}`);
  const viewEl = printEl.createDiv({
    cls: "markdown-preview-view markdown-rendered" + cssclasses.join(" "),
  });

  // @ts-ignore
  viewEl.toggleClass("rtl", app.vault.getConfig("rightToLeft"));
  // @ts-ignore
  viewEl.toggleClass("show-properties", "hidden" !== app.vault.getConfig("propertiesInDocument"));

  const title = extra?.title ?? frontMatter?.title ?? file.basename;
  viewEl.createEl("h1", { text: title }, (e) => {
    e.addClass("__title__");
    e.style.display = config?.showTitle ? "block" : "none";
    e.id = extra?.id ?? "";
  });

  const cache = app.metadataCache.getFileCache(file);

  // const lines = data?.split("\n") ?? [];
  // Object.entries(cache?.blocks ?? {}).forEach(([key, c]) => {
  //   const idx = c.position.end.line;
  //   lines[idx] = `<span id="^${key}" class="blockid"></span>\n` + lines[idx];
  // });

  const blocks = new Map(Object.entries(cache?.blocks ?? {}));
  const lines = (data?.split("\n") ?? []).map((line, i) => {
    for (const {
      id,
      position: { start, end },
    } of blocks.values()) {
      const blockid = `^${id}`;
      if (line.includes(blockid) && i >= start.line && i <= end.line) {
        blocks.delete(id);
        return line.replace(blockid, `<span id="${blockid}" class="blockid"></span> ${blockid}`);
      }
    }
    return line;
  });

  [...blocks.values()].forEach(({ id, position: { start, end } }) => {
    const idx = start.line;
    lines[idx] = `<span id="^${id}" class="blockid"></span>\n\n` + lines[idx];
  });

  const fragment = {
    children: undefined as HTMLCollection | undefined,
    appendChild(this: { children: HTMLCollection | undefined }, e: DocumentFragment) {
      this.children = e?.children;
      throw new Error("exit");
    },
  } as unknown as HTMLElement;

  const promises: AyncFnType[] = [];
  try {
    // `render` converts Markdown to HTML, and then it undergoes postProcess handling.
    // Here, postProcess handling is not needed.When passed as a fragment, it converts to HTML correctly,
    // but errors occur during recent postProcess handling, thus achieving the goal of avoiding postProcess handling.
    await MarkdownRenderer.render(app, lines.join("\n"), fragment, file.path, comp);
  } catch (error) {
    /* empty */
  }

  const el = createFragment();
  Array.from(fragment.children).forEach((item) => {
    el.createDiv({}, (t) => {
      return t.appendChild(item);
    });
  });

  viewEl.appendChild(el);

  // @ts-ignore
  // (app: App: param: T) => T
  // MarkdownPostProcessorContext
  await MarkdownRenderer.postProcess(app, {
    docId: generateDocId(16),
    sourcePath: file.path,
    frontmatter: {},
    promises,
    addChild: function (e: Component) {
      return comp.addChild(e);
    },
    getSectionInfo: function () {
      return null;
    },
    containerEl: viewEl,
    el: viewEl,
    displayMode: true,
  });
  await Promise.all(promises);

  printEl.findAll("a.internal-link").forEach((el) => {
    const [title, anchor] = el.dataset.href?.split("#") ?? [];

    if ((!title || title?.length == 0 || title == file.basename) && anchor?.startsWith("^")) {
      return;
    }

    el.removeAttribute("href");
  });
  try {
    await fixWaitRender(data, viewEl);
  } catch (error) {
    console.warn("wait timeout");
  }

  fixCanvasToImage(viewEl);

  const doc = document.implementation.createHTMLDocument("document");
  doc.body.appendChild(printEl.cloneNode(true));

  printEl.detach();
  comp.unload();
  printEl.remove();
  doc.title = title;
  leaf.detach();
  console.debug(`md render time:${new Date().getTime() - startTime}ms`);
  return { doc, frontMatter, file };
}

export async function renderMarkdownV2({
  app,
  file,
  config,
  extra,
  exportTheme = currentExportTheme,
}: ParamType) {
  const startTime = new Date().getTime();

  const data = await app.vault.cachedRead(file);
  if (!data) {
    new Notice(`${file} content is empty!`);
  }

  const comp = new Component();
  comp.load();

  const printEl = document.body.createDiv({
    cls: `print theme-${exportTheme}`,
    attr: {
      id: file.path,
    },
  });
  const { viewEl, frontMatter } = createViewEl({ app, file, extra, config, printEl });

  const markdown = modifyMarkdown({ app, file, data });

  await renderHtml({ app, markdown, file, comp, viewEl });

  const cleanup = () => {
    printEl.detach();
    comp.unload();
    printEl.remove();
  };
  console.debug(`md render time:${new Date().getTime() - startTime}ms`);

  return { doc: printEl, frontMatter, file, cleanup };
}

export function createViewEl({
  app,
  file,
  printEl,
  extra,
  config,
}: {
  app: App;
  file: TFile;
  printEl: HTMLDivElement;
  extra: { title?: string; file?: TFile; id?: string } | undefined;
  config?: ExportConfigType;
}) {
  const frontMatter = getFrontMatter(app, file);

  const viewEl = printEl.createDiv({ cls: "markdown-preview-view markdown-rendered" });

  const cssclasses = getCssclasses(frontMatter);
  viewEl.addClasses(cssclasses);

  // @ts-ignore
  // 设置阅读方向和属性显示
  viewEl.toggleClass("rtl", app.vault.getConfig("rightToLeft"));
  // @ts-ignore
  viewEl.toggleClass("show-properties", "hidden" !== app.vault.getConfig("propertiesInDocument"));

  const title = extra?.title ?? frontMatter?.title ?? file.basename;
  viewEl.createEl("h1", { text: title }, (e) => {
    e.addClass("__title__");
    e.style.display = config?.showTitle ? "block" : "none";
    e.id = extra?.id ?? "";
  });
  return { viewEl, frontMatter };
}

// 添加块ID
export function modifyMarkdown({ app, file, data }: { app: App; file: TFile; data: string }) {
  const cache = app.metadataCache.getFileCache(file);

  const blocks = new Map(Object.entries(cache?.blocks ?? {}));
  const lines = (data?.split("\n") ?? []).map((line, i) => {
    for (const {
      id,
      position: { start, end },
    } of blocks.values()) {
      const blockid = `^${id}`;
      if (line.includes(blockid) && i >= start.line && i <= end.line) {
        blocks.delete(id);
        return line.replace(blockid, `<span id="${blockid}" class="blockid"></span> ${blockid}`);
      }
    }
    return line;
  });

  [...blocks.values()].forEach(({ id, position: { start, end } }) => {
    const idx = start.line;
    lines[idx] = `<span id="^${id}" class="blockid"></span>\n\n` + lines[idx];
  });
  return lines.join("\n");
}

async function renderHtml({
  app,
  markdown,
  file,
  comp,
  viewEl,
}: {
  app: App;
  markdown: string;
  file: TFile;
  comp: Component;
  viewEl: HTMLDivElement;
}) {
  const fragment = {
    children: undefined as HTMLCollection | undefined,
    appendChild(this: { children: HTMLCollection | undefined }, e: DocumentFragment) {
      this.children = e?.children;
      throw new Error("exit");
    },
  } as unknown as HTMLElement;

  const promises: AyncFnType[] = [];
  try {
    // `render` converts Markdown to HTML, and then it undergoes postProcess handling.
    // Here, postProcess handling is not needed.When passed as a fragment, it converts to HTML correctly,
    // but errors occur during recent postProcess handling, thus achieving the goal of avoiding postProcess handling.
    await MarkdownRenderer.render(app, markdown, fragment, file.path, comp);
  } catch (error) {
    /* empty */
  }

  const el = createFragment();
  Array.from(fragment.children).forEach((item) => {
    el.createDiv({}, (t) => {
      return t.appendChild(item);
    });
  });

  viewEl.appendChild(el);

  // @ts-ignore
  // (app: App: param: T) => T
  // MarkdownPostProcessorContext
  await MarkdownRenderer.postProcess(app, {
    docId: generateDocId(16),
    sourcePath: file.path,
    frontmatter: {},
    promises,
    addChild: function (e: Component) {
      return comp.addChild(e);
    },
    getSectionInfo: function () {
      return null;
    },
    containerEl: viewEl,
    el: viewEl,
    displayMode: true,
  });
  await Promise.all(promises);

  viewEl.findAll("a.internal-link").forEach((el) => {
    const [title, anchor] = el.dataset.href?.split("#") ?? [];

    if ((!title || title?.length == 0 || title == file.basename) && anchor?.startsWith("^")) {
      return;
    }

    el.removeAttribute("href");
  });
}

export function fixDoc(doc: Document, title: string) {
  const dest = modifyDest(doc);
  fixAnchors(doc, dest, title);
  encodeEmbeds(doc);
  return doc;
}

export function fixDocV2(doc: Document | HTMLDivElement, title: string) {
  const dest = modifyDest(doc);
  fixAnchors(doc, dest, title);
  return doc;
}

export function encodeEmbeds(doc: Document) {
  const spans = Array.from(doc.querySelectorAll<HTMLElement>("span.markdown-embed")).reverse();
  spans.forEach((span: HTMLElement) => (span.innerHTML = encodeURIComponent(span.innerHTML)));
}

export async function fixWaitRender(data: string, viewEl: HTMLElement) {
  if (data.includes("```dataview") || data.includes("```gEvent") || data.includes("![[")) {
    await sleep(2000);
  }
  try {
    await waitForDomChange(viewEl);
  } catch (error) {
    await sleep(1000);
  }
}

// TODO: base64 to canvas
// TODO: light render canvas
export function fixCanvasToImage(el: HTMLElement) {
  for (const canvas of Array.from(el.querySelectorAll("canvas"))) {
    const data = canvas.toDataURL();
    const img = document.createElement("img");
    img.src = data;
    copyAttributes(img, canvas.attributes);
    img.className = "__canvas__";

    canvas.replaceWith(img);
  }
}

export function createWebview(scale = 1.25) {
  const webview = document.createElement("webview");
  webview.src = `app://obsidian.md/help.html`;
  webview.setAttribute(
    "style",
    `height:calc(${scale} * 100%);
     width: calc(${scale} * 100%);
     transform: scale(${1 / scale}, ${1 / scale});
     transform-origin: top left;
     border: 1px solid #f2f2f2;
    `,
  );
  webview.nodeintegration = true;
  return webview;
}

export function makeWebviewJs(doc: Document, exportTheme: ExportTheme) {
  const oppositeTheme = exportTheme === "light" ? "dark" : "light";
  return `
      document.body.innerHTML = decodeURIComponent(\`${encodeURIComponent(doc.body.innerHTML)}\`);
      document.head.innerHTML = decodeURIComponent(\`${encodeURIComponent(document.head.innerHTML)}\`);

      // Function to recursively decode and replace innerHTML of span.markdown-embed elements
      function decodeAndReplaceEmbed(element) {
				// Replace the innerHTML with the decoded content
        element.innerHTML = decodeURIComponent(element.innerHTML);
				// Check if the new content contains further span.markdown-embed elements
        const newEmbeds = element.querySelectorAll("span.markdown-embed");
        newEmbeds.forEach(decodeAndReplaceEmbed);
      }

      // Start the process with all span.markdown-embed elements in the document
      document.querySelectorAll("span.markdown-embed").forEach(decodeAndReplaceEmbed);

      document.body.setAttribute("class", \`${document.body.getAttribute("class")}\`)
      document.body.setAttribute("style", \`${document.body.getAttribute("style")}\`)
      document.body.addClass("theme-${exportTheme}");
      document.body.removeClass("theme-${oppositeTheme}");
      document.title = \`${doc.title}\`;
      `;
}

function waitForDomChange(target: HTMLElement, timeout = 2000, interval = 200): Promise<boolean> {
  return new Promise((resolve, reject) => {
    let timer: NodeJS.Timeout;
    const observer = new MutationObserver((m) => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        observer.disconnect();
        resolve(true);
      }, interval);
    });

    observer.observe(target, {
      childList: true,
      subtree: true,
      attributes: true,
      characterData: true,
    });

    setTimeout(() => {
      observer.disconnect();
      reject(new Error(`timeout ${timeout}ms`));
    }, timeout);
  });
}

// Obsidian's own two base color schemes, keyed by our light/dark export theme.
// (Obsidian's vault "theme" config also allows "system" — adapt to OS.)
const BASE_THEME_ID: Record<ExportTheme, string> = { light: "moonstone", dark: "obsidian" };

/**
 * @param printEl
 * @param options
 * @param exportTheme
 * @param app When the vault's appearance is "Adapt to system", Obsidian keeps a
 * listener that re-syncs document.body's theme class to the OS color scheme.
 * Chromium's print pipeline triggers that listener mid-print (confirmed via
 * CDP media emulation), silently reverting our manual body class swap below —
 * this is why a "dark" export could render with a light background even
 * though the class swap looked correct at the time it was applied. Passing
 * `app` lets us force an explicit, non-"system" base theme for the duration
 * of the print so that listener has nothing to react to; the original vault
 * setting is restored afterwards.
 */
export async function printToPdf(
  printEl: any,
  options: electron.PrintToPDFOptions & {
    filepath: string;
  },
  exportTheme: ExportTheme = currentExportTheme,
  app?: App,
) {
  const ipc = printEl.win.electron.ipcRenderer as electron.IpcRenderer;
  const doc = printEl.ownerDocument ?? document;
  const body = doc.body;
  const oppositeTheme = exportTheme === "light" ? "dark" : "light";

  // @ts-ignore
  const prevVaultTheme = app?.vault.getConfig("theme");
  if (app && prevVaultTheme !== BASE_THEME_ID[exportTheme]) {
    // @ts-ignore
    app.vault.setConfig("theme", BASE_THEME_ID[exportTheme]);
    app.workspace.trigger("css-change");
    await new Promise((r) => setTimeout(r, 50));
  }

  // printToPDF captures the ENTIRE webContents, not just printEl. So the export
  // theme must be applied to the real document.body — that is the root at which
  // Obsidian's formula variables (e.g. --background-primary: var(--color-base-00))
  // are computed before the nested .print element inherits them. Applying the
  // theme only to the nested root cannot recompute those inherited variables.
  // Swap the body theme for the duration of the print and restore it afterwards.
  // The V2 export path serializes prints via a Mutex, so this shared mutation is
  // safe. A brief theme flash of the app UI behind the modal is expected.
  const prevBodyClass = body.className;
  printEl.addClass(`theme-${exportTheme}`);
  printEl.removeClass(`theme-${oppositeTheme}`);
  body.addClass(`theme-${exportTheme}`);
  body.removeClass(`theme-${oppositeTheme}`);

  // Paint the note's background/text for the export theme (the .print root is
  // otherwise transparent → white page + invisible text for dark exports).
  const printThemeStyle = applyPrintThemeStyle(printEl, exportTheme);
  // Dark exports also paint the @page box (margins); removed once printing done.
  const pageBackgroundStyle = applyPrintPageBackgroundStyle(printEl, exportTheme);

  try {
    return await new Promise((resolve) => {
      // 1.ipc先设置监听（确保不会错过主进程的回信）
      ipc.once("print-to-pdf", (event, result) => {
        resolve(result); // 收到回复时，结束等待
      });

      // 2. 发送请求
      ipc.send("print-to-pdf", options);
    });
  } finally {
    printThemeStyle.remove();
    pageBackgroundStyle?.remove();
    body.className = prevBodyClass; // restore the app's own theme
    if (app && prevVaultTheme !== undefined && prevVaultTheme !== BASE_THEME_ID[exportTheme]) {
      // @ts-ignore
      app.vault.setConfig("theme", prevVaultTheme);
      app.workspace.trigger("css-change");
    }
  }
}

export function getCssclasses(frontMatter: FrontMatterCache) {
  const cssclasses = [];
  for (const [key, val] of Object.entries(frontMatter)) {
    if (key.toLowerCase() == "cssclass" || key.toLowerCase() == "cssclasses") {
      if (Array.isArray(val)) {
        cssclasses.push(...val);
      } else {
        cssclasses.push(val);
      }
    }
  }
  return cssclasses;
}

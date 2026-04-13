import puppeteer from "puppeteer";
import { fileURLToPath } from "url";
import { createClient } from "@supabase/supabase-js";
import { tmpdir } from "os";
import { readdirSync, readFileSync, unlinkSync } from "fs";
import { join } from "path";

const BASE_URL = "http://asdempleados.dusakawiepsi.com:8080/sie_dusakawi";
const USUARIO = "1067815531";
const CLAVE = "Wanoseshas2015@";
const ANNO = "2026";

const SUPABASE_URL = "https://sstuwlwukjokhjbtelig.supabase.co";
const SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNzdHV3bHd1a2pva2hqYnRlbGlnIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3NTIyMTA4OSwiZXhwIjoyMDkwNzk3MDg5fQ.H4THTo8FDVPBRmPS28rHcHeprFyE87UmS5sD_qopn8Y";
const BUCKET = "bases";

const sleep = ms => new Promise(r => setTimeout(r, ms));

function getFechas() {
  const FECHA_INICIO = "01/01/2026";
  const today = new Date();
  const FECHA_FIN = `${String(today.getDate()).padStart(2, "0")}/${String(today.getMonth() + 1).padStart(2, "0")}/${today.getFullYear()}`;
  const FILE_NAME = `auditoria_hospitalaria_${FECHA_FIN.replace(/\//g, "-")}.xlsx`;
  return { FECHA_INICIO, FECHA_FIN, FILE_NAME };
}

async function setDateField(page, input, value) {
  await input.click({ clickCount: 3 });
  await input.type(value);
  await page.keyboard.press("Tab");
  await sleep(400);
  const actual = await page.evaluate(el => el.value, input);
  if (actual !== value) {
    await page.evaluate((el, v) => {
      el.value = v;
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }, input, value);
    await sleep(300);
  }
}

// Esperar a que aparezca un archivo nuevo en el directorio
async function waitForNewFile(dir, beforeFiles, timeoutMs = 90000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await sleep(1500);
    const after = readdirSync(dir);
    const newFiles = after.filter(f =>
      !beforeFiles.has(f) &&
      !f.endsWith(".tmp") &&
      !f.endsWith(".crdownload") &&
      !f.endsWith(".part")
    );
    if (newFiles.length > 0) return join(dir, newFiles[0]);
  }
  return null;
}

export async function descargarAuditoria({ headless = true } = {}) {
  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
  const { FECHA_INICIO, FECHA_FIN, FILE_NAME } = getFechas();
  const downloadDir = tmpdir();

  console.log(`📅 Rango: ${FECHA_INICIO} → ${FECHA_FIN}`);
  console.log(`📁 Temp dir: ${downloadDir}`);

  const browser = await puppeteer.launch({
    headless,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    defaultViewport: { width: 1400, height: 900 },
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--single-process",
    ],
  });

  const page = await browser.newPage();

  // ── Configurar directorio de descarga via CDP ─────────────────────────────
  const client = await page.createCDPSession();
  await client.send("Page.setDownloadBehavior", {
    behavior: "allow",
    downloadPath: downloadDir,
  });

  try {
    // Timeout global alto para sitio lento
    page.setDefaultNavigationTimeout(90000);
    page.setDefaultTimeout(60000);

    // ── 1. Login ──────────────────────────────────────────────────────────────
    console.log("🔐 Iniciando sesión...");
    await page.goto(`${BASE_URL}/login.xhtml`, { waitUntil: "domcontentloaded", timeout: 90000 });

    const allInputs = await page.$$('input[type="text"], input[type="password"], input:not([type="hidden"]):not([type="submit"]):not([type="button"])');
    console.log(`  Campos en login: ${allInputs.length}`);
    if (allInputs.length >= 1) await allInputs[0].type(USUARIO);
    if (allInputs.length >= 2) await allInputs[1].type(CLAVE);
    if (allInputs.length >= 3) {
      await allInputs[2].click({ clickCount: 3 });
      await allInputs[2].type(ANNO);
    }

    await page.click('button[type="submit"], input[type="submit"]');
    await page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 90000 });
    console.log("✅ Login OK");

    // ── 2. Ir a Calidad de Salud ──────────────────────────────────────────────
    await page.goto(`${BASE_URL}/calidad_salud.xhtml?URL_ANTERIOR=calidad_salud`, { waitUntil: "domcontentloaded", timeout: 90000 });
    await sleep(3000);

    const menuHeaders = await page.$$(".ui-panelmenu-header");
    for (const h of menuHeaders) {
      try { await h.click(); await sleep(600); } catch {}
    }
    await sleep(2000);

    // ── 3. Click "Auditoría Hospitalaria" ─────────────────────────────────────
    const clickedMenu = await page.evaluate(() => {
      const items = [...document.querySelectorAll(".ui-menuitem-text, a")];
      const item = items.find(el => {
        const t = el.textContent.trim();
        return t.includes("Auditor") && t.toLowerCase().includes("hospitalaria");
      });
      if (item) { item.click(); return item.textContent.trim(); }
      return null;
    });

    if (!clickedMenu) {
      await page.goto(
        `${BASE_URL}/pages/audit/auditoria_hospitalaria/auditoria_hospitalaria.xhtml`,
        { waitUntil: "domcontentloaded", timeout: 90000 }
      );
    }
    console.log(`✅ Menú: ${clickedMenu || "navegación directa"}`);
    await sleep(3000);

    // ── 4. Click "Reporte" ────────────────────────────────────────────────────
    await page.evaluate(() => {
      const btns = [...document.querySelectorAll("button, .ui-button, a, input[type='submit']")];
      const btn = btns.find(b => (b.textContent || b.value || "").trim().toLowerCase() === "reporte");
      if (btn) btn.click();
    });
    await sleep(3000);

    // ── 5. Fechas ─────────────────────────────────────────────────────────────
    const dateInputs = await page.$$(
      ".ui-calendar input, input[id*='fecha'], input[id*='Fecha'], input[id*='date'], input[id*='Date']"
    );
    if (dateInputs.length >= 2) {
      await setDateField(page, dateInputs[0], FECHA_INICIO);
      await setDateField(page, dateInputs[1], FECHA_FIN);
      console.log(`✅ Fechas: ${FECHA_INICIO} → ${FECHA_FIN}`);
    } else {
      console.log(`⚠️  Solo ${dateInputs.length} campo(s) de fecha encontrado(s)`);
    }

    // ── 6. Tipo Reporte ───────────────────────────────────────────────────────
    const selects = await page.$$("select");
    for (const sel of selects) {
      const options = await sel.$$eval("option", opts =>
        opts.map(o => ({ v: o.value, t: o.textContent.trim() }))
      );
      const target = options.find(o =>
        o.t.toLowerCase().includes("detallado") ||
        (o.t.toLowerCase().includes("audit") && o.t.toLowerCase().includes("hospital"))
      );
      if (target) {
        await sel.select(target.v);
        console.log(`✅ Tipo Reporte: "${target.t}"`);
      }
    }
    await sleep(500);

    // ── 7. Exportar — capturar lista de archivos antes de clic ───────────────
    const filesBefore = new Set(readdirSync(downloadDir));
    console.log(`📂 Archivos en temp antes: ${filesBefore.size}`);

    await page.evaluate(() => {
      const btns = [...document.querySelectorAll("button, .ui-button, input[type='submit'], a.ui-commandlink")];
      const btn = btns.find(b => {
        const t = (b.textContent || b.value || "").toLowerCase();
        return t.includes("exportar") || t.includes("export") || t.includes("generar") || t.includes("descarg");
      });
      if (btn) { btn.click(); console.log("Clicked:", btn.textContent); }
    });
    console.log("⏳ Esperando descarga en temp...");

    // ── 8. Esperar archivo en temp ────────────────────────────────────────────
    const downloadedPath = await waitForNewFile(downloadDir, filesBefore, 90000);

    if (!downloadedPath) throw new Error("No apareció ningún archivo en el directorio temporal");

    console.log(`📦 Archivo capturado: ${downloadedPath}`);
    const fileBuffer = readFileSync(downloadedPath);
    const sizeKB = (fileBuffer.length / 1024).toFixed(1);

    // Borrar el archivo temporal inmediatamente
    try { unlinkSync(downloadedPath); } catch {}

    // ── 9. Subir a Supabase ───────────────────────────────────────────────────
    console.log(`☁️  Subiendo a Supabase: bases/${FILE_NAME} (${sizeKB} KB)...`);
    const { error } = await supabase.storage.from(BUCKET).upload(FILE_NAME, fileBuffer, {
      contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      upsert: true,
    });

    if (error) throw new Error(`Supabase upload: ${error.message}`);
    console.log(`✅ Guardado en Supabase: bases/${FILE_NAME}`);

    return { success: true, fileName: FILE_NAME, sizeKB, fechaInicio: FECHA_INICIO, fechaFin: FECHA_FIN };

  } finally {
    await browser.close();
  }
}

// ── Ejecución directa ─────────────────────────────────────────────────────────
const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  descargarAuditoria({ headless: false }).catch(err => {
    console.error("❌ Error:", err.message);
    process.exit(1);
  });
}

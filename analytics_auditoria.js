import { createClient } from "@supabase/supabase-js";
import * as XLSX from "xlsx";

const SUPABASE_URL = "https://sstuwlwukjokhjbtelig.supabase.co";
const SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNzdHV3bHd1a2pva2hqYnRlbGlnIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3NTIyMTA4OSwiZXhwIjoyMDkwNzk3MDg5fQ.H4THTo8FDVPBRmPS28rHcHeprFyE87UmS5sD_qopn8Y";
const BUCKET = "bases";

// ── Helpers ───────────────────────────────────────────────────────────────────

function topN(map, n = 5) {
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([k, v]) => ({ nombre: k, cantidad: v }));
}

function contarPorCampo(rows, campo) {
  const map = new Map();
  for (const row of rows) {
    const val = String(row[campo] ?? "Sin datos").trim();
    if (val) map.set(val, (map.get(val) || 0) + 1);
  }
  return map;
}

// Detectar nombres de columna de forma flexible (case-insensitive + acentos)
function detectarColumna(headers, patrones) {
  const norm = s => s.toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "");
  for (const h of headers) {
    for (const p of patrones) {
      if (norm(h).includes(norm(p))) return h;
    }
  }
  return null;
}

// ── Analítica principal ───────────────────────────────────────────────────────

function computeAnalitica(workbook) {
  const results = [];

  for (const sheetName of workbook.SheetNames) {
    const ws = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(ws, { defval: "" });

    if (rows.length === 0) continue;

    const headers = Object.keys(rows[0]);

    // ── Detectar columnas relevantes ─────────────────────────────────────────
    const colUsuario   = detectarColumna(headers, ["usuario", "paciente", "nombre", "user"]);
    const colEstado    = detectarColumna(headers, ["estado", "status", "situacion", "situación"]);
    const colTipo      = detectarColumna(headers, ["tipo", "modalidad", "clase", "internacion", "internación", "hospitalizacion", "hospitalización"]);
    const colIP        = detectarColumna(headers, ["ip", "sede", "institucion", "institución", "ips", "entidad"]);
    const colFecha     = detectarColumna(headers, ["fecha", "date", "ingreso", "egreso"]);
    const colDiag      = detectarColumna(headers, ["diagnostico", "diagnóstico", "dx", "cie"]);
    const colAuditoria = detectarColumna(headers, ["auditoria", "auditoría", "audit"]);

    const totalRegistros = rows.length;

    // ── Usuarios únicos ──────────────────────────────────────────────────────
    const usuariosUnicos = colUsuario
      ? new Set(rows.map(r => String(r[colUsuario]).trim()).filter(Boolean)).size
      : null;

    // ── Auditorías abiertas vs cerradas ──────────────────────────────────────
    let abiertas = 0, cerradas = 0, estadoMap = new Map();
    if (colEstado) {
      estadoMap = contarPorCampo(rows, colEstado);
      for (const [k, v] of estadoMap) {
        const kn = k.toLowerCase();
        if (kn.includes("abiert") || kn.includes("activ") || kn.includes("pend")) abiertas += v;
        else if (kn.includes("cerrad") || kn.includes("finaliz") || kn.includes("complet")) cerradas += v;
      }
    }

    // ── Tipos de internación ─────────────────────────────────────────────────
    const tiposMap = colTipo ? contarPorCampo(rows, colTipo) : new Map();

    // ── IPs / Sedes con más usuarios ─────────────────────────────────────────
    let ipUsuariosMap = new Map();
    if (colIP && colUsuario) {
      for (const row of rows) {
        const ip = String(row[colIP] ?? "").trim();
        const usr = String(row[colUsuario] ?? "").trim();
        if (!ip || !usr) continue;
        if (!ipUsuariosMap.has(ip)) ipUsuariosMap.set(ip, new Set());
        ipUsuariosMap.get(ip).add(usr);
      }
      // Convertir sets a conteos
      ipUsuariosMap = new Map([...ipUsuariosMap.entries()].map(([k, v]) => [k, v.size]));
    } else if (colIP) {
      ipUsuariosMap = contarPorCampo(rows, colIP);
    }

    // ── Rango de fechas ──────────────────────────────────────────────────────
    let fechaMin = null, fechaMax = null;
    if (colFecha) {
      const fechas = rows
        .map(r => {
          const v = r[colFecha];
          if (!v) return null;
          const d = new Date(v);
          return isNaN(d) ? null : d;
        })
        .filter(Boolean);
      if (fechas.length) {
        fechaMin = new Date(Math.min(...fechas)).toLocaleDateString("es-CO");
        fechaMax = new Date(Math.max(...fechas)).toLocaleDateString("es-CO");
      }
    }

    // ── Diagnósticos más frecuentes ──────────────────────────────────────────
    const diagMap = colDiag ? contarPorCampo(rows, colDiag) : new Map();

    results.push({
      hoja: sheetName,
      totalRegistros,
      usuariosUnicos,
      abiertas,
      cerradas,
      estadoMap,
      tiposMap,
      ipUsuariosMap,
      diagMap,
      colsDetectadas: { colUsuario, colEstado, colTipo, colIP, colFecha, colDiag, colAuditoria },
      headers,
      fechaMin,
      fechaMax,
    });
  }

  return results;
}

// ── Formatear reporte como texto Telegram ────────────────────────────────────

export function formatearReporte(analytics, archivoNombre = "reporte") {
  if (!analytics || analytics.length === 0) {
    return "⚠️ No se encontraron datos en el archivo.";
  }

  const lines = [];
  lines.push(`📊 *ANALÍTICA DE AUDITORÍA HOSPITALARIA*`);
  lines.push(`📁 Archivo: \`${archivoNombre}\``);
  lines.push(`🕐 Generado: ${new Date().toLocaleString("es-CO", { timeZone: "America/Bogota" })}`);
  lines.push("");

  for (const sheet of analytics) {
    if (analytics.length > 1) {
      lines.push(`📋 *Hoja: ${sheet.hoja}*`);
    }

    lines.push(`📌 *Resumen General*`);
    lines.push(`  • Total registros: *${sheet.totalRegistros.toLocaleString()}*`);
    if (sheet.usuariosUnicos !== null) {
      lines.push(`  • Usuarios únicos: *${sheet.usuariosUnicos.toLocaleString()}*`);
    }

    if (sheet.fechaMin && sheet.fechaMax) {
      lines.push(`  • Período: ${sheet.fechaMin} → ${sheet.fechaMax}`);
    }

    // Estado / Auditorías abiertas
    if (sheet.estadoMap.size > 0) {
      lines.push("");
      lines.push(`🔓 *Estado de Auditorías*`);
      if (sheet.abiertas > 0) lines.push(`  • Abiertas/Activas: *${sheet.abiertas}*`);
      if (sheet.cerradas > 0) lines.push(`  • Cerradas/Finalizadas: *${sheet.cerradas}*`);
      const otros = sheet.totalRegistros - sheet.abiertas - sheet.cerradas;
      if (otros > 0) {
        for (const [k, v] of topN(sheet.estadoMap, 10)) {
          const ya = (k.toLowerCase().includes("abiert") || k.toLowerCase().includes("activ") ||
                      k.toLowerCase().includes("pend") || k.toLowerCase().includes("cerrad") ||
                      k.toLowerCase().includes("finaliz"));
          if (!ya) lines.push(`  • ${k}: ${v}`);
        }
      }
    }

    // Tipos de internación
    if (sheet.tiposMap.size > 0) {
      lines.push("");
      lines.push(`🏥 *Tipos de Internación*`);
      for (const { nombre, cantidad } of topN(sheet.tiposMap, 10)) {
        const pct = ((cantidad / sheet.totalRegistros) * 100).toFixed(1);
        lines.push(`  • ${nombre}: *${cantidad}* (${pct}%)`);
      }
    }

    // IPs / Sedes con más usuarios
    if (sheet.ipUsuariosMap.size > 0) {
      lines.push("");
      lines.push(`🏢 *IPs / Sedes con más usuarios*`);
      for (const { nombre, cantidad } of topN(sheet.ipUsuariosMap, 7)) {
        lines.push(`  • ${nombre}: *${cantidad}*`);
      }
    }

    // Diagnósticos más frecuentes
    if (sheet.diagMap.size > 0) {
      lines.push("");
      lines.push(`🔬 *Top Diagnósticos*`);
      for (const { nombre, cantidad } of topN(sheet.diagMap, 5)) {
        lines.push(`  • ${nombre}: *${cantidad}*`);
      }
    }

    // Columnas detectadas (debug útil)
    const colsDet = Object.values(sheet.colsDetectadas).filter(Boolean);
    if (colsDet.length > 0) {
      lines.push("");
      lines.push(`🔎 _Columnas analizadas: ${colsDet.join(", ")}_`);
    }

    lines.push("");
  }

  return lines.join("\n");
}

// ── Obtener analítica desde Supabase ─────────────────────────────────────────

export async function obtenerAnalitica() {
  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

  // 1. Listar archivos en el bucket, tomar el más reciente
  const { data: archivos, error: listErr } = await supabase.storage.from(BUCKET).list("", {
    limit: 50,
    sortBy: { column: "created_at", order: "desc" },
  });

  if (listErr) throw new Error(`Error listando Supabase: ${listErr.message}`);

  const excelFiles = (archivos || []).filter(f =>
    f.name.endsWith(".xlsx") || f.name.endsWith(".xls")
  );

  if (excelFiles.length === 0) {
    throw new Error("No hay archivos Excel en Supabase. Usa /descargar primero.");
  }

  const archivo = excelFiles[0]; // más reciente

  // 2. Descargar el archivo
  const { data: fileData, error: dlErr } = await supabase.storage
    .from(BUCKET)
    .download(archivo.name);

  if (dlErr) throw new Error(`Error descargando ${archivo.name}: ${dlErr.message}`);

  const buffer = Buffer.from(await fileData.arrayBuffer());

  // 3. Parsear con xlsx
  const workbook = XLSX.read(buffer, { type: "buffer", cellDates: true });

  // 4. Computar analítica
  const analytics = computeAnalitica(workbook);

  return { analytics, archivoNombre: archivo.name };
}

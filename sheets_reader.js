/**
 * sheets_reader.js
 * Lee el Google Sheet público (alimentado por el Apps Script de Auditoria)
 * y expone funciones para analítica y búsqueda por cédula.
 *
 * Sheet ID: 1BvYBlquNuIbRyvDE-Ej5KbHv9zyVCaa2
 * El Apps Script escribe los datos en la hoja "DATOS" o "POWEBI" (primera hoja).
 */

import fetch from "node-fetch";
import * as XLSX from "xlsx";

const SHEET_ID = process.env.GOOGLE_SHEET_ID || "1BvYBlquNuIbRyvDE-Ej5KbHv9zyVCaa2";
const EXPORT_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=xlsx`;

// ── Helpers ───────────────────────────────────────────────────────────────────

function normalizar(s) {
  return String(s ?? "").trim().toLowerCase()
    .normalize("NFD").replace(/\p{Diacritic}/gu, "");
}

function detectarCol(headers, patrones) {
  const n = s => normalizar(s);
  for (const h of headers)
    for (const p of patrones)
      if (n(h).includes(n(p))) return h;
  return null;
}

function topN(map, n = 7) {
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n);
}

// ── Descarga del workbook ─────────────────────────────────────────────────────

export async function descargarWorkbook() {
  const res = await fetch(EXPORT_URL, {
    headers: { "User-Agent": "Mozilla/5.0" },
    redirect: "follow",
  });
  if (!res.ok) {
    throw new Error(
      `No se pudo leer el Google Sheet (HTTP ${res.status}). ` +
      `Verifica que sea público: Archivo → Compartir → "Cualquier persona con el enlace puede ver".`
    );
  }
  const buf = Buffer.from(await res.arrayBuffer());
  return XLSX.read(buf, { type: "buffer", cellDates: true });
}

// ── Todas las filas del Sheet (primera hoja con datos) ────────────────────────

export async function obtenerFilas() {
  const wb = await descargarWorkbook();
  for (const name of wb.SheetNames) {
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { defval: "" });
    if (rows.length > 0) return { rows, hoja: name };
  }
  throw new Error("El Sheet no tiene datos. Ejecuta el Apps Script primero.");
}

// ── Analítica completa ────────────────────────────────────────────────────────

export async function obtenerAnaliticaSheet() {
  const { rows, hoja } = await obtenerFilas();
  const headers = Object.keys(rows[0]);

  const colId     = detectarCol(headers, ["identificacion","cedula","nro_doc","documento","numero_id","id_paciente","numid"]);
  const colNombre = detectarCol(headers, ["nombre","paciente","afiliado"]);
  const colEstado = detectarCol(headers, ["estado","status","situacion"]);
  const colTipo   = detectarCol(headers, ["tipo","modalidad","clase","internacion","hospitalizacion"]);
  const colIP     = detectarCol(headers, ["ips","ip","sede","institucion","entidad","prestador"]);
  const colFecha  = detectarCol(headers, ["fecha","ingreso","egreso","date"]);
  const colDiag   = detectarCol(headers, ["diagnostico","dx","cie","diag"]);

  // Conteos
  const estadoMap = new Map(), tipoMap = new Map(), ipMap = new Map(), diagMap = new Map();
  const ipUsuarios = new Map(); // ip → Set de cédulas
  let abiertas = 0, cerradas = 0;

  for (const row of rows) {
    const estado = String(row[colEstado] ?? "").trim();
    const tipo   = String(row[colTipo]   ?? "Sin tipo").trim() || "Sin tipo";
    const ip     = String(row[colIP]     ?? "Sin IP").trim()   || "Sin IP";
    const diag   = String(row[colDiag]   ?? "").trim();
    const id     = String(row[colId]     ?? "").trim();

    if (estado) estadoMap.set(estado, (estadoMap.get(estado) || 0) + 1);
    tipoMap.set(tipo, (tipoMap.get(tipo) || 0) + 1);
    ipMap.set(ip,   (ipMap.get(ip)   || 0) + 1);
    if (diag) diagMap.set(diag, (diagMap.get(diag) || 0) + 1);

    if (ip && id) {
      if (!ipUsuarios.has(ip)) ipUsuarios.set(ip, new Set());
      ipUsuarios.get(ip).add(id);
    }

    const en = normalizar(estado);
    if (en.includes("abiert") || en.includes("activ") || en.includes("pend")) abiertas++;
    else if (en.includes("cerrad") || en.includes("finaliz") || en.includes("complet")) cerradas++;
  }

  // Usuarios únicos
  const usuariosUnicos = colId
    ? new Set(rows.map(r => String(r[colId]).trim()).filter(Boolean)).size
    : null;

  // Rango fechas
  let fechaMin = null, fechaMax = null;
  if (colFecha) {
    const fechas = rows.map(r => { const d = new Date(r[colFecha]); return isNaN(d) ? null : d; }).filter(Boolean);
    if (fechas.length) {
      fechaMin = new Date(Math.min(...fechas)).toLocaleDateString("es-CO");
      fechaMax = new Date(Math.max(...fechas)).toLocaleDateString("es-CO");
    }
  }

  // IP con más usuarios únicos
  const ipUsrMap = new Map([...ipUsuarios.entries()].map(([k, v]) => [k, v.size]));

  return {
    hoja, total: rows.length, usuariosUnicos,
    abiertas, cerradas, estadoMap, tipoMap,
    ipMap, ipUsrMap, diagMap,
    fechaMin, fechaMax,
    colsDetectadas: { colId, colNombre, colEstado, colTipo, colIP, colFecha, colDiag },
  };
}

// ── Formatear reporte analítica ───────────────────────────────────────────────

export function formatearAnalitica(a, fuente = "Google Sheet") {
  const lineas = [
    `📊 *ANALÍTICA — AUDITORÍA HOSPITALARIA*`,
    `🔗 Fuente: ${fuente}  •  Hoja: \`${a.hoja}\``,
    `🕐 ${new Date().toLocaleString("es-CO", { timeZone: "America/Bogota" })}`,
    ``,
    `📌 *Resumen*`,
    `  • Total registros: *${a.total.toLocaleString()}*`,
  ];
  if (a.usuariosUnicos) lineas.push(`  • Usuarios/pacientes únicos: *${a.usuariosUnicos.toLocaleString()}*`);
  if (a.fechaMin)       lineas.push(`  • Período: ${a.fechaMin} → ${a.fechaMax}`);

  if (a.abiertas || a.cerradas) {
    lineas.push(``, `🔓 *Estado de Auditorías*`);
    if (a.abiertas) lineas.push(`  • Abiertas / Activas: *${a.abiertas}*`);
    if (a.cerradas) lineas.push(`  • Cerradas / Finalizadas: *${a.cerradas}*`);
    const otros = a.total - a.abiertas - a.cerradas;
    if (otros > 0) lineas.push(`  • Otros estados: ${otros}`);
  } else if (a.estadoMap.size) {
    lineas.push(``, `🔓 *Estados*`);
    for (const [k, v] of topN(a.estadoMap, 8))
      lineas.push(`  • ${k}: *${v}*`);
  }

  if (a.tipoMap.size) {
    lineas.push(``, `🏥 *Tipos de Internación*`);
    for (const [k, v] of topN(a.tipoMap, 10)) {
      const pct = ((v / a.total) * 100).toFixed(1);
      lineas.push(`  • ${k}: *${v}* (${pct}%)`);
    }
  }

  if (a.ipUsrMap.size) {
    lineas.push(``, `🏢 *IPs / Sedes — usuarios únicos*`);
    for (const [k, v] of topN(a.ipUsrMap, 7))
      lineas.push(`  • ${k}: *${v}*`);
  } else if (a.ipMap.size) {
    lineas.push(``, `🏢 *IPs / Sedes*`);
    for (const [k, v] of topN(a.ipMap, 7))
      lineas.push(`  • ${k}: *${v}*`);
  }

  if (a.diagMap.size) {
    lineas.push(``, `🔬 *Top Diagnósticos*`);
    for (const [k, v] of topN(a.diagMap, 5))
      lineas.push(`  • ${k}: *${v}*`);
  }

  return lineas.join("\n");
}

// ── Búsqueda por cédula ───────────────────────────────────────────────────────

export async function buscarPorCedula(cedula) {
  const { rows, hoja } = await obtenerFilas();
  const headers = Object.keys(rows[0]);

  const colId     = detectarCol(headers, ["identificacion","cedula","nro_doc","documento","numero_id","id_paciente","numid"]);
  const colNombre = detectarCol(headers, ["nombre","paciente","afiliado"]);
  const colEstado = detectarCol(headers, ["estado","status","situacion"]);
  const colTipo   = detectarCol(headers, ["tipo","modalidad","clase","internacion","hospitalizacion"]);
  const colIP     = detectarCol(headers, ["ips","ip","sede","institucion","entidad","prestador"]);
  const colFecha  = detectarCol(headers, ["fecha","ingreso","egreso","date"]);
  const colDiag   = detectarCol(headers, ["diagnostico","dx","cie","diag"]);

  // Buscar filas donde aparezca la cédula (en cualquier columna de ID o en toda la fila)
  const encontradas = rows.filter(row => {
    if (colId) return String(row[colId]).trim() === cedula;
    // Fallback: buscar en todos los campos
    return Object.values(row).some(v => String(v).trim() === cedula);
  });

  return { encontradas, hoja, colNombre, colEstado, colTipo, colIP, colFecha, colDiag };
}

// ── Formatear evolución de un paciente ───────────────────────────────────────

export function formatearEvolucion(cedula, resultado) {
  const { encontradas, colNombre, colEstado, colTipo, colIP, colFecha, colDiag } = resultado;

  if (encontradas.length === 0) {
    return `🔍 No se encontraron registros para la cédula *${cedula}* en el último reporte.\n\n_Verifica que el número sea correcto o actualiza el reporte con /descargar._`;
  }

  const nombre = colNombre ? String(encontradas[0][colNombre] || "").trim() : "";
  const lineas = [
    `👤 *Evolución del Concurrente*`,
    nombre ? `  Paciente: *${nombre}*` : "",
    `  Cédula: \`${cedula}\``,
    `  Registros encontrados: *${encontradas.length}*`,
    ``,
  ].filter(l => l !== "");

  // Ordenar por fecha si existe
  let registros = [...encontradas];
  if (colFecha) {
    registros.sort((a, b) => {
      const da = new Date(a[colFecha]), db = new Date(b[colFecha]);
      return (isNaN(da) ? 0 : da) - (isNaN(db) ? 0 : db);
    });
  }

  registros.forEach((row, i) => {
    lineas.push(`*Registro ${i + 1}*`);
    if (colFecha  && row[colFecha])  lineas.push(`  📅 Fecha: ${new Date(row[colFecha]).toLocaleDateString("es-CO")}`);
    if (colTipo   && row[colTipo])   lineas.push(`  🏥 Tipo: ${row[colTipo]}`);
    if (colEstado && row[colEstado]) lineas.push(`  🔖 Estado: ${row[colEstado]}`);
    if (colIP     && row[colIP])     lineas.push(`  🏢 IPS: ${row[colIP]}`);
    if (colDiag   && row[colDiag])   lineas.push(`  🔬 Dx: ${row[colDiag]}`);
    lineas.push("");
  });

  return lineas.join("\n").trim();
}

/**
 * sheets_reader.js
 * Lee el Google Sheet alimentado por el Apps Script de Auditoría Hospitalaria.
 *
 * Columnas conocidas del sheet (fila 1):
 * IPS | Nombre Paciente | Tipo Identificacion | Numero Identificacion | Edad |
 * IPS Primaria | Sexo | Departamento | Municipio | Dirección | Teléfonos |
 * Correo Electrónico | Fecha Ingreso | Fecha Egreso | Estancia | Diagnostico |
 * Cie10 Diagnostico | Servicio | IPS Remite | Especialidad | Estado | Auditor |
 * Cie10 Egreso | Estado del Egreso | Destino Egreso | Eventos Adversos |
 * Cantidad Evento no calidad | CUPS | Salud Publica | Glosas | Valor Total Glosa |
 * Estado Ingreso | Observación Ingreso | Observación Seguimiento | Gestación |
 * Control Prenatal | Via Parto | Dx Gestante | VDRL | Fecha Recién Nacido |
 * Dx Recién Nacido | Peso Recién Nacido | Talla Recién Nacido |
 * Tipo Documento Recién Nacido | Número Documento Recién Nacido |
 * Número Gestación Recién Nacido | Fecha Última Menstruación |
 * Fecha Problable Parto | Metodo Planificación | Reingreso | Programa Riesgo |
 * Patologia alto costo
 */

import fetch from "node-fetch";
import * as XLSX from "xlsx";

const SHEET_ID   = process.env.GOOGLE_SHEET_ID || "1BvYBlquNuIbRyvDE-Ej5KbHv9zyVCaa2";
const EXPORT_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=xlsx`;

// ── Utilidades ────────────────────────────────────────────────────────────────

function topN(map, n = 8) {
  return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
}

function contar(rows, col) {
  const m = new Map();
  for (const r of rows) {
    const v = String(r[col] ?? "").trim() || "Sin dato";
    m.set(v, (m.get(v) || 0) + 1);
  }
  return m;
}

function sumar(rows, col) {
  return rows.reduce((acc, r) => {
    const v = parseFloat(String(r[col] ?? "").replace(/[^0-9.]/g, ""));
    return acc + (isNaN(v) ? 0 : v);
  }, 0);
}

function formatFecha(v) {
  if (!v) return "";
  const d = new Date(v);
  return isNaN(d) ? String(v) : d.toLocaleDateString("es-CO");
}

function formatMoney(n) {
  return "$" + Math.round(n).toLocaleString("es-CO");
}

// ── Descarga workbook ─────────────────────────────────────────────────────────

export async function descargarWorkbook() {
  const res = await fetch(EXPORT_URL, {
    headers: { "User-Agent": "Mozilla/5.0" },
    redirect: "follow",
  });
  if (!res.ok) {
    throw new Error(
      `No se pudo leer el Google Sheet (HTTP ${res.status}).\n` +
      `Verifica que esté compartido: Archivo → Compartir → "Cualquier persona con el enlace puede ver".`
    );
  }
  const buf = Buffer.from(await res.arrayBuffer());
  return XLSX.read(buf, { type: "buffer", cellDates: true });
}

// ── Obtener filas (primera hoja con datos) ────────────────────────────────────

export async function obtenerFilas() {
  const wb = await descargarWorkbook();
  for (const name of wb.SheetNames) {
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { defval: "" });
    if (rows.length > 0) return { rows, hoja: name };
  }
  throw new Error("El Sheet está vacío. Ejecuta el Apps Script para poblar los datos.");
}

// ── Analítica completa ────────────────────────────────────────────────────────

export async function obtenerAnaliticaSheet() {
  const { rows, hoja } = await obtenerFilas();

  // Columnas exactas del sheet
  const C = {
    IPS:          "IPS",
    NOMBRE:       "Nombre Paciente",
    TIPO_ID:      "Tipo Identificacion",
    CEDULA:       "Numero Identificacion",
    EDAD:         "Edad",
    IPS_PRIM:     "IPS Primaria",
    SEXO:         "Sexo",
    DPTO:         "Departamento",
    MUNICIPIO:    "Municipio",
    FECHA_ING:    "Fecha Ingreso",
    FECHA_EGR:    "Fecha Egreso",
    ESTANCIA:     "Estancia",
    DIAGNOSTICO:  "Diagnostico",
    CIE10:        "Cie10 Diagnostico",
    SERVICIO:     "Servicio",
    ESPECIALIDAD: "Especialidad",
    ESTADO:       "Estado",
    AUDITOR:      "Auditor",
    ESTADO_EGR:   "Estado del Egreso",
    DESTINO_EGR:  "Destino Egreso",
    EVENTOS_ADV:  "Eventos Adversos",
    GLOSAS:       "Glosas",
    VALOR_GLOSA:  "Valor Total Glosa",
    ESTADO_ING:   "Estado Ingreso",
    REINGRESO:    "Reingreso",
    PROG_RIESGO:  "Programa Riesgo",
    ALTO_COSTO:   "Patologia alto costo",
    GESTACION:    "Gestación",
    VIA_PARTO:    "Via Parto",
    SALUD_PUB:    "Salud Publica",
  };

  const total = rows.length;

  // Usuarios únicos por cédula
  const usuariosUnicos = new Set(rows.map(r => String(r[C.CEDULA]).trim()).filter(Boolean)).size;

  // Estados de auditoría
  const estadoMap = contar(rows, C.ESTADO);
  let abiertas = 0, cerradas = 0;
  for (const [k, v] of estadoMap) {
    const kn = k.toLowerCase();
    if (kn.includes("abiert") || kn.includes("activ") || kn.includes("pend") || kn.includes("proceso"))
      abiertas += v;
    else if (kn.includes("cerrad") || kn.includes("finaliz") || kn.includes("complet") || kn.includes("egres"))
      cerradas += v;
  }

  // Servicios / tipos de internación
  const servicioMap = contar(rows, C.SERVICIO);

  // IPS con más usuarios únicos
  const ipUsuarios = new Map();
  for (const r of rows) {
    const ip  = String(r[C.IPS] ?? "").trim()    || "Sin IPS";
    const ced = String(r[C.CEDULA] ?? "").trim();
    if (!ipUsuarios.has(ip)) ipUsuarios.set(ip, new Set());
    if (ced) ipUsuarios.get(ip).add(ced);
  }
  const ipUsrMap = new Map([...ipUsuarios.entries()].map(([k, v]) => [k, v.size]));

  // Diagnósticos más frecuentes
  const diagMap = contar(rows, C.DIAGNOSTICO);

  // Especialidades
  const espMap = contar(rows, C.ESPECIALIDAD);

  // Glosas
  const conGlosa    = rows.filter(r => String(r[C.GLOSAS] ?? "").trim().toLowerCase() === "si" ||
                                        String(r[C.GLOSAS] ?? "").trim() === "1" ||
                                        parseFloat(r[C.VALOR_GLOSA]) > 0).length;
  const totalGlosa  = sumar(rows, C.VALOR_GLOSA);

  // Reingresos
  const reingresos  = rows.filter(r => String(r[C.REINGRESO] ?? "").trim().toLowerCase() === "si" ||
                                        String(r[C.REINGRESO] ?? "").trim() === "1").length;

  // Programas de riesgo
  const riesgoMap   = contar(rows, C.PROG_RIESGO);

  // Patología alto costo
  const altoCostoMap = contar(rows, C.ALTO_COSTO);

  // Eventos adversos
  const eventosAdv  = rows.filter(r => String(r[C.EVENTOS_ADV] ?? "").trim() !== "" &&
                                        String(r[C.EVENTOS_ADV] ?? "").trim().toLowerCase() !== "no" &&
                                        String(r[C.EVENTOS_ADV] ?? "").trim() !== "0").length;

  // Rango de fechas
  let fechaMin = null, fechaMax = null;
  const fechas = rows.map(r => { const d = new Date(r[C.FECHA_ING]); return isNaN(d) ? null : d; }).filter(Boolean);
  if (fechas.length) {
    fechaMin = new Date(Math.min(...fechas)).toLocaleDateString("es-CO");
    fechaMax = new Date(Math.max(...fechas)).toLocaleDateString("es-CO");
  }

  // Sexo
  const sexoMap = contar(rows, C.SEXO);

  // Auditor con más casos
  const auditorMap = contar(rows, C.AUDITOR);

  return {
    hoja, total, usuariosUnicos,
    abiertas, cerradas, estadoMap,
    servicioMap, ipUsrMap, ipUsuarios,
    diagMap, espMap, riesgoMap, altoCostoMap, sexoMap, auditorMap,
    conGlosa, totalGlosa, reingresos, eventosAdv,
    fechaMin, fechaMax,
  };
}

// ── Formatear reporte ─────────────────────────────────────────────────────────

export function formatearAnalitica(a) {
  const pct = (n) => ((n / a.total) * 100).toFixed(1) + "%";
  const L = [];

  L.push(`📊 *ANALÍTICA — AUDITORÍA HOSPITALARIA*`);
  L.push(`📅 Período: ${a.fechaMin || "?"} → ${a.fechaMax || "?"}`);
  L.push(`🕐 ${new Date().toLocaleString("es-CO", { timeZone: "America/Bogota" })}`);
  L.push(``);
  L.push(`📌 *Resumen General*`);
  L.push(`  • Total registros: *${a.total.toLocaleString()}*`);
  L.push(`  • Usuarios únicos: *${a.usuariosUnicos.toLocaleString()}*`);

  // Estados
  L.push(``);
  L.push(`🔓 *Estado de Auditorías*`);
  L.push(`  • Abiertas / En proceso: *${a.abiertas}* (${pct(a.abiertas)})`);
  L.push(`  • Cerradas / Egresados: *${a.cerradas}* (${pct(a.cerradas)})`);
  if (a.total - a.abiertas - a.cerradas > 0) {
    for (const [k, v] of topN(a.estadoMap, 6)) {
      const kn = k.toLowerCase();
      const yaContado = kn.includes("abiert")||kn.includes("activ")||kn.includes("pend")||
                        kn.includes("proceso")||kn.includes("cerrad")||kn.includes("finaliz")||
                        kn.includes("complet")||kn.includes("egres");
      if (!yaContado && k !== "Sin dato") L.push(`  • ${k}: ${v}`);
    }
  }

  // Servicios
  if (a.servicioMap.size) {
    L.push(``);
    L.push(`🏥 *Servicios / Tipos de Internación*`);
    for (const [k, v] of topN(a.servicioMap, 8))
      L.push(`  • ${k}: *${v}* (${pct(v)})`);
  }

  // IPS con más usuarios
  L.push(``);
  L.push(`🏢 *IPS con más usuarios únicos*`);
  for (const [k, v] of topN(a.ipUsrMap, 7))
    L.push(`  • ${k}: *${v}*`);

  // Especialidades
  if (a.espMap.size) {
    L.push(``);
    L.push(`👨‍⚕️ *Top Especialidades*`);
    for (const [k, v] of topN(a.espMap, 5))
      L.push(`  • ${k}: *${v}*`);
  }

  // Diagnósticos
  if (a.diagMap.size) {
    L.push(``);
    L.push(`🔬 *Top Diagnósticos*`);
    for (const [k, v] of topN(a.diagMap, 5))
      L.push(`  • ${k}: *${v}*`);
  }

  // Alertas clínicas
  L.push(``);
  L.push(`⚠️ *Alertas Clínicas*`);
  L.push(`  • Reingresos: *${a.reingresos}* (${pct(a.reingresos)})`);
  L.push(`  • Eventos adversos: *${a.eventosAdv}*`);
  if (a.conGlosa > 0) {
    L.push(`  • Con glosa: *${a.conGlosa}* (${pct(a.conGlosa)})`);
    if (a.totalGlosa > 0) L.push(`  • Valor total glosas: *${formatMoney(a.totalGlosa)}*`);
  }

  // Programas de riesgo
  const riesgoFiltrado = [...a.riesgoMap.entries()].filter(([k]) => k !== "Sin dato" && k !== "");
  if (riesgoFiltrado.length) {
    L.push(``);
    L.push(`🎯 *Programas de Riesgo*`);
    for (const [k, v] of riesgoFiltrado.sort((a,b)=>b[1]-a[1]).slice(0,5))
      L.push(`  • ${k}: *${v}*`);
  }

  // Patología alto costo
  const acFiltrado = [...a.altoCostoMap.entries()].filter(([k]) => k !== "Sin dato" && k !== "" && k.toLowerCase() !== "no");
  if (acFiltrado.length) {
    L.push(``);
    L.push(`💊 *Patología Alto Costo*`);
    for (const [k, v] of acFiltrado.sort((a,b)=>b[1]-a[1]).slice(0,5))
      L.push(`  • ${k}: *${v}*`);
  }

  return L.join("\n");
}

// ── Búsqueda por cédula ───────────────────────────────────────────────────────

export async function buscarPorCedula(cedula) {
  const { rows, hoja } = await obtenerFilas();

  const encontradas = rows.filter(r =>
    String(r["Numero Identificacion"] ?? "").trim() === cedula.trim()
  );

  return { encontradas, hoja };
}

// ── Formatear evolución del paciente ─────────────────────────────────────────

export function formatearEvolucion(cedula, resultado) {
  const { encontradas } = resultado;

  if (encontradas.length === 0) {
    return (
      `🔍 No se encontraron registros para la cédula *${cedula}*.\n\n` +
      `_Verifica el número o usa /descargar para actualizar el reporte._`
    );
  }

  const p        = encontradas[0];
  const nombre   = String(p["Nombre Paciente"] ?? "").trim();
  const edad     = String(p["Edad"] ?? "").trim();
  const sexo     = String(p["Sexo"] ?? "").trim();
  const programa = String(p["Programa Riesgo"] ?? "").trim();
  const altoCosto = String(p["Patologia alto costo"] ?? "").trim();

  const L = [];
  L.push(`👤 *Evolución del Concurrente*`);
  if (nombre) L.push(`  Paciente: *${nombre}*`);
  L.push(`  Cédula: \`${cedula}\``);
  if (edad)  L.push(`  Edad: ${edad} años  |  Sexo: ${sexo}`);
  if (programa && programa !== "" && programa.toLowerCase() !== "sin dato")
    L.push(`  Programa Riesgo: ${programa}`);
  if (altoCosto && altoCosto !== "" && altoCosto.toLowerCase() !== "no" && altoCosto.toLowerCase() !== "sin dato")
    L.push(`  Alto Costo: ${altoCosto}`);
  L.push(`  Total registros: *${encontradas.length}*`);
  L.push(``);

  // Ordenar por fecha de ingreso
  const registros = [...encontradas].sort((a, b) => {
    const da = new Date(a["Fecha Ingreso"]), db = new Date(b["Fecha Ingreso"]);
    return (isNaN(da) ? 0 : da.getTime()) - (isNaN(db) ? 0 : db.getTime());
  });

  registros.forEach((r, i) => {
    L.push(`*── Registro ${i + 1} ──*`);

    const ips       = String(r["IPS"] ?? "").trim();
    const ipsPrim   = String(r["IPS Primaria"] ?? "").trim();
    const fIngreso  = formatFecha(r["Fecha Ingreso"]);
    const fEgreso   = formatFecha(r["Fecha Egreso"]);
    const estancia  = String(r["Estancia"] ?? "").trim();
    const servicio  = String(r["Servicio"] ?? "").trim();
    const esp       = String(r["Especialidad"] ?? "").trim();
    const diag      = String(r["Diagnostico"] ?? "").trim();
    const cie10     = String(r["Cie10 Diagnostico"] ?? "").trim();
    const estado    = String(r["Estado"] ?? "").trim();
    const estadoEgr = String(r["Estado del Egreso"] ?? "").trim();
    const destino   = String(r["Destino Egreso"] ?? "").trim();
    const auditor   = String(r["Auditor"] ?? "").trim();
    const reingreso = String(r["Reingreso"] ?? "").trim();
    const glosa     = String(r["Glosas"] ?? "").trim();
    const valGlosa  = parseFloat(String(r["Valor Total Glosa"] ?? "").replace(/[^0-9.]/g, ""));
    const evAdv     = String(r["Eventos Adversos"] ?? "").trim();
    const obsIng    = String(r["Observación Ingreso"] ?? "").trim();
    const obsSeg    = String(r["Observación Seguimiento"] ?? "").trim();
    const estadoIng = String(r["Estado Ingreso"] ?? "").trim();

    if (ips)       L.push(`  🏥 IPS: ${ips}`);
    if (ipsPrim && ipsPrim !== ips) L.push(`  🏥 IPS Primaria: ${ipsPrim}`);
    if (fIngreso)  L.push(`  📅 Ingreso: ${fIngreso}${fEgreso ? "  →  Egreso: " + fEgreso : "  *(en curso)*"}`);
    if (estancia)  L.push(`  ⏱ Estancia: ${estancia} días`);
    if (servicio)  L.push(`  🔧 Servicio: ${servicio}`);
    if (esp)       L.push(`  👨‍⚕️ Especialidad: ${esp}`);
    if (diag)      L.push(`  🔬 Diagnóstico: ${diag}${cie10 ? " (" + cie10 + ")" : ""}`);
    if (estado)    L.push(`  🔖 Estado auditoría: *${estado}*`);
    if (estadoIng) L.push(`  🔖 Estado ingreso: ${estadoIng}`);
    if (estadoEgr) L.push(`  🚪 Estado egreso: ${estadoEgr}${destino ? " → " + destino : ""}`);
    if (auditor)   L.push(`  👤 Auditor: ${auditor}`);
    if (reingreso.toLowerCase() === "si" || reingreso === "1") L.push(`  🔄 *REINGRESO*`);
    if ((glosa.toLowerCase() === "si" || glosa === "1") && !isNaN(valGlosa) && valGlosa > 0)
      L.push(`  💰 Glosa: ${formatMoney(valGlosa)}`);
    if (evAdv && evAdv !== "" && evAdv.toLowerCase() !== "no" && evAdv !== "0")
      L.push(`  ⚠️ Evento adverso: ${evAdv}`);
    if (obsIng)    L.push(`  📝 Obs. Ingreso: _${obsIng}_`);
    if (obsSeg)    L.push(`  📝 Obs. Seguimiento: _${obsSeg}_`);
    L.push(``);
  });

  return L.join("\n").trim();
}

/**
 * ============================================
 * WEBHOOKS DE ENTRADA DE LEADS — Auto del Sol
 * ============================================
 * Dos endpoints:
 *   POST /api/webhooks/whatsapp-bot   -> leads que entran por el bot de WhatsApp
 *   POST /api/webhooks/zapier-formularios -> leads de formularios via Zapier
 *
 * Ambos usan la MISMA lógica de asignación: primero intentan la
 * distribución ponderada (services/distribucion.service.js) si hay un
 * equipo/líder configurado para recibir estos leads; si no, caen a un
 * round-robin parejo entre todos los vendedores activos.
 *
 * Autenticación: header `x-api-key`, validado contra LEAD_API_KEYS en
 * el .env (ver middleware/intakeAuth.js). Formato de esa variable:
 *   whatsapp-bot:clave123;zapier-formularios:clave456
 *
 * Para agregar más fuentes en el futuro, el patrón es: duplicar uno de
 * estos dos bloques, cambiar la ruta y el nombre del provider en
 * LEAD_API_KEYS. La lógica de asignación (asignarVendedor) es
 * reutilizable tal cual.
 */

const express = require('express');
const pool = require('../db');
const intakeAuth = require('../middleware/intakeAuth');
const dist = require('../services/distribucion.service');
const router = express.Router();

// Round-robin parejo de emergencia, para cuando no hay ningún equipo
// configurado en distribucion_equipos todavía.
let roundRobinIndex = 0;

async function getVendedoresActivos() {
  const [rows] = await pool.execute(
    `SELECT id, name FROM users WHERE role = 'vendedor' AND active = 1 ORDER BY id`
  );
  return rows;
}

/**
 * Elige un vendedor para el lead nuevo.
 * - Si existe un líder/equipo gestionado por distribucion_equipos con
 *   scope 'general' (ver nota abajo), reparte por porcentaje.
 * - Si no, round-robin parejo entre todos los vendedores activos.
 *
 * NOTA: a diferencia de GoldPlan (que tiene un gerente/equipo por cada
 * fuente de leads), acá todavía no hay esa jerarquía armada. Si en el
 * futuro se arma un equipo específico para leads de WhatsApp o de
 * formularios, lo más simple es registrar ese líder en
 * distribucion_equipos y reemplazar este fallback por
 * dist.siguienteVendedor(liderId, leadId, fuente).
 */
async function asignarVendedor(leadId, fuente) {
  const vendedores = await getVendedoresActivos();
  if (vendedores.length === 0) return null;

  const vendedor = vendedores[roundRobinIndex % vendedores.length];
  roundRobinIndex = (roundRobinIndex + 1) % vendedores.length;

  console.log(`[${fuente}] Lead #${leadId || '?'} -> ${vendedor.name} (${vendedor.id})`);
  return vendedor.id;
}

// ========================================
// POST /api/webhooks/whatsapp-bot
// Leads que entran por el bot de WhatsApp
// ========================================
router.post('/whatsapp-bot', intakeAuth, async (req, res) => {
  try {
    const { nombre, telefono, modelo, notas, formaPago } = req.body;

    console.log('[whatsapp-bot] Recibido:', JSON.stringify(req.body));

    if (!nombre || !telefono) {
      return res.status(400).json({
        error: 'Nombre y telefono son requeridos',
        received: { nombre, telefono }
      });
    }

    const assigned_to = await asignarVendedor(null, 'whatsapp-bot');
    if (!assigned_to) {
      return res.status(500).json({ error: 'No hay vendedores activos para asignar' });
    }

    const [result] = await pool.execute(
      `INSERT INTO leads
        (nombre, telefono, modelo, marca, formaPago, estado, fuente, notas, assigned_to, created_at, assigned_at)
       VALUES
        (?, ?, ?, 'peugeot', ?, 'nuevo', 'community', ?, ?, NOW(), NOW())`,
      [
        nombre,
        telefono,
        modelo || 'Consultar',
        formaPago || 'Consultar',
        notas || '',
        assigned_to
      ]
    );

    const [leadRows] = await pool.execute('SELECT * FROM leads WHERE id = ?', [result.insertId]);
    const lead = leadRows[0] || null;

    // Emitir en tiempo real, igual que hace el middleware de server.js para /api/leads
    const io = req.app.get('io');
    if (io && lead) {
      io.emit('lead:created', lead);
    }

    res.json({
      ok: true,
      lead,
      leadId: result.insertId,
      assignedTo: assigned_to,
      fuente: 'whatsapp-bot'
    });
  } catch (error) {
    console.error('[whatsapp-bot] Error:', error);
    res.status(500).json({ error: 'Error al procesar lead' });
  }
});

// ========================================
// POST /api/webhooks/zapier-formularios
// Leads de formularios (landing, redes, etc.) vía Zapier
// ========================================
router.post('/zapier-formularios', intakeAuth, async (req, res) => {
  try {
    const { nombre, telefono, modelo, notas, formaPago, email } = req.body;

    console.log('[zapier-formularios] Recibido:', JSON.stringify(req.body));

    if (!nombre || !telefono) {
      return res.status(400).json({
        error: 'Nombre y telefono son requeridos',
        received: { nombre, telefono }
      });
    }

    const assigned_to = await asignarVendedor(null, 'zapier-formularios');
    if (!assigned_to) {
      return res.status(500).json({ error: 'No hay vendedores activos para asignar' });
    }

    const notasFinal = email ? `Mail: ${email}${notas ? ' | ' + notas : ''}` : (notas || '');

    const [result] = await pool.execute(
      `INSERT INTO leads
        (nombre, telefono, modelo, marca, formaPago, estado, fuente, notas, assigned_to, created_at, assigned_at)
       VALUES
        (?, ?, ?, 'peugeot', ?, 'nuevo', 'community', ?, ?, NOW(), NOW())`,
      [
        nombre,
        telefono,
        modelo || 'Consultar',
        formaPago || 'Consultar',
        notasFinal,
        assigned_to
      ]
    );

    const [leadRows] = await pool.execute('SELECT * FROM leads WHERE id = ?', [result.insertId]);
    const lead = leadRows[0] || null;

    const io = req.app.get('io');
    if (io && lead) {
      io.emit('lead:created', lead);
    }

    res.json({
      ok: true,
      lead,
      leadId: result.insertId,
      assignedTo: assigned_to,
      fuente: 'zapier-formularios'
    });
  } catch (error) {
    console.error('[zapier-formularios] Error:', error);
    res.status(500).json({ error: 'Error al procesar lead' });
  }
});

// ========================================
// GET /api/webhooks/health
// ========================================
router.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    roundRobinIndex
  });
});

module.exports = router;

'use strict';
/**
 * Report engine: each builder returns { title, columns, rows, subtitle }.
 * The same data feeds the JSON preview, the Excel renderer and the PDF renderer.
 * Column types: text | int | money | hours (value stored in minutes) | minutes
 */
const fs = require('fs');
const ExcelJS = require('exceljs');
const PDFDocument = require('pdfkit');
const { query } = require('../db');
const { bad } = require('../utils/http');
const { getSettings } = require('./settings');
const { listAttendance } = require('./attendance');
const { getRun } = require('./payroll');
const { fmtMoney } = require('../utils/money');
const { fmtMin } = require('../utils/time');

const C = (key, header, type = 'text', width = 1, extra = {}) => ({ key, header, type, width, ...extra });

const BUILDERS = {
  attendance: {
    title: 'Daily Attendance Report',
    async build({ from, to, userId, department, status, deviceSn }) {
      const rows = (await listAttendance({ from, to, userId, department, status, deviceSn }))
        .filter((r) => status || !['weekend', 'holiday'].includes(r.status))
        .map((r) => {
          const hasIn = r.check_in_local && r.check_in_local !== '—';
          const hasOut = r.check_out_local && r.check_out_local !== '—';
          let outDisplay = '—';
          if (hasOut) {
            outDisplay = r.check_out_local;
          } else if (hasIn) {
            outDisplay = 'Missing Checkout';
          }
          return {
            ...r,
            check_in_local: r.check_in_local || '—',
            check_out_local: outDisplay,
            status: r.status.replace('_', ' ')
          };
        });
      return {
        columns: [
          C('work_date', 'Date', 'text', 0.95),
          C('employee_code', 'Code', 'text', 0.75),
          C('name', 'Employee', 'text', 1.7),
          C('department', 'Department', 'text', 1.2),
          C('device_name', 'Terminal / Machine', 'text', 1.3),
          C('shift_name', 'Shift', 'text', 1.1),
          C('check_in_local', 'In Time', 'text', 0.75),
          C('check_out_local', 'Out Time', 'text', 1.15),
          C('worked_minutes', 'Worked (h)', 'hours', 0.85, { sum: true }),
          C('late_minutes', 'Late (min)', 'int', 0.7, { sum: true }),
          C('status', 'Status', 'text', 0.85)
        ],
        rows,
      };
    },
  },
  summary: {
    title: 'Employee attendance summary',
    async build({ from, to, userId, department }) {
      const params = [from, to];
      let where = `a.work_date BETWEEN $1 AND $2 AND a.status NOT IN ('weekend','holiday')`;
      if (userId) { params.push(userId); where += ` AND a.user_id = $${params.length}`; }
      if (department) { params.push(department); where += ` AND u.department = $${params.length}`; }
      const { rows } = await query(
        `SELECT u.employee_code, u.name, u.department,
                COUNT(*) FILTER (WHERE a.status IN ('present','late','half_day'))::int AS present,
                COUNT(*) FILTER (WHERE a.late_minutes > 0)::int AS late_count,
                COALESCE(SUM(a.late_minutes), 0)::int AS late_minutes,
                COUNT(*) FILTER (WHERE a.early_out_minutes > 0)::int AS early_count,
                COUNT(*) FILTER (WHERE a.status = 'half_day')::int AS half_days,
                COUNT(*) FILTER (WHERE a.status IN ('leave','unpaid_leave'))::int AS leave_days,
                COUNT(*) FILTER (WHERE a.status = 'absent')::int AS absent,
                COALESCE(SUM(a.worked_minutes), 0)::int AS worked_minutes,
                COALESCE(SUM(a.overtime_minutes), 0)::int AS overtime_minutes
           FROM attendance a JOIN users u ON u.id = a.user_id WHERE ${where}
          GROUP BY u.id ORDER BY u.name`, params);
      return {
        columns: [C('employee_code', 'Code', 'text', 0.8), C('name', 'Employee', 'text', 1.8), C('department', 'Department', 'text', 1.3),
          C('present', 'Present', 'int', 0.8, { sum: true }), C('late_count', 'Late days', 'int', 0.8, { sum: true }),
          C('late_minutes', 'Late (min)', 'int', 0.9, { sum: true }), C('early_count', 'Early-outs', 'int', 0.9, { sum: true }),
          C('half_days', 'Half days', 'int', 0.8, { sum: true }), C('leave_days', 'Leave', 'int', 0.7, { sum: true }),
          C('absent', 'Absent', 'int', 0.7, { sum: true }), C('worked_minutes', 'Worked (h)', 'hours', 0.9, { sum: true }),
          C('overtime_minutes', 'OT (h)', 'hours', 0.8, { sum: true })],
        rows,
      };
    },
  },
  overtime: {
    title: 'Overtime',
    async build({ from, to, userId, department }) {
      const params = [from, to];
      let where = `a.work_date BETWEEN $1 AND $2 AND a.overtime_minutes > 0`;
      if (userId) { params.push(userId); where += ` AND a.user_id = $${params.length}`; }
      if (department) { params.push(department); where += ` AND u.department = $${params.length}`; }
      const { rows } = await query(
        `SELECT u.employee_code, u.name, u.department,
                COUNT(*)::int AS days,
                COALESCE(SUM(a.overtime_minutes) FILTER (WHERE NOT a.off_day_work), 0)::int AS regular_minutes,
                COALESCE(SUM(a.overtime_minutes) FILTER (WHERE a.off_day_work), 0)::int AS off_day_minutes,
                SUM(a.overtime_minutes)::int AS total_minutes
           FROM attendance a JOIN users u ON u.id = a.user_id WHERE ${where}
          GROUP BY u.id ORDER BY SUM(a.overtime_minutes) DESC`, params);
      return {
        columns: [C('employee_code', 'Code', 'text', 0.8), C('name', 'Employee', 'text', 2), C('department', 'Department', 'text', 1.4),
          C('days', 'Days with OT', 'int', 1, { sum: true }), C('regular_minutes', 'Regular OT (h)', 'hours', 1.1, { sum: true }),
          C('off_day_minutes', 'Off-day OT (h)', 'hours', 1.1, { sum: true }), C('total_minutes', 'Total OT (h)', 'hours', 1.1, { sum: true })],
        rows,
      };
    },
  },
  leave: {
    title: 'Leave requests',
    async build({ from, to, userId, department, status }) {
      const params = [from, to];
      let where = 'lr.start_date <= $2 AND lr.end_date >= $1';
      if (userId) { params.push(userId); where += ` AND lr.user_id = $${params.length}`; }
      if (department) { params.push(department); where += ` AND u.department = $${params.length}`; }
      if (status) { params.push(status); where += ` AND lr.status = $${params.length}`; }
      const { rows } = await query(
        `SELECT u.employee_code, u.name, u.department, lt.name AS type, lr.start_date::text AS start_date, lr.end_date::text AS end_date,
                lr.days, lr.status, COALESCE(rv.name, '') AS reviewer, lr.reason
           FROM leave_requests lr JOIN users u ON u.id = lr.user_id JOIN leave_types lt ON lt.id = lr.leave_type_id
           LEFT JOIN users rv ON rv.id = lr.reviewed_by WHERE ${where} ORDER BY lr.start_date DESC, u.name`, params);
      return {
        columns: [C('employee_code', 'Code', 'text', 0.8), C('name', 'Employee', 'text', 1.7), C('department', 'Department', 'text', 1.2),
          C('type', 'Type', 'text', 1.1), C('start_date', 'From', 'text', 1), C('end_date', 'To', 'text', 1), C('days', 'Days', 'int', 0.6, { sum: true }),
          C('status', 'Status', 'text', 0.9), C('reviewer', 'Reviewed by', 'text', 1.3), C('reason', 'Reason', 'text', 2)],
        rows,
      };
    },
  },
  payroll: {
    title: 'Payroll register',
    async build({ month }) {
      if (!month) throw bad('Choose a payroll month');
      const data = await getRun(month);
      if (!data) throw bad(`No payroll has been generated for ${month}`);
      return {
        subtitle: `${month} · ${data.run.status}${data.run.partial ? ' (partial month)' : ''}`,
        columns: [C('employee_code', 'Code', 'text', 0.8), C('name', 'Employee', 'text', 1.8), C('department', 'Department', 'text', 1.2),
          C('base_pay', 'Base pay', 'money', 1, { sum: true }), C('allowances', 'Allowances', 'money', 1, { sum: true }),
          C('overtime_pay', 'Overtime', 'money', 1, { sum: true }), C('bonus', 'Bonus', 'money', 0.9, { sum: true }),
          C('gross', 'Gross', 'money', 1.1, { sum: true }), C('absence_deduction', 'Absence', 'money', 0.9, { sum: true }),
          C('late_deduction', 'Late', 'money', 0.8, { sum: true }), C('pf_deduction', 'PF', 'money', 0.8, { sum: true }),
          C('tax_deduction', 'Tax', 'money', 0.8, { sum: true }), C('other_deduction', 'Other', 'money', 0.8, { sum: true }),
          C('net_pay', 'Net pay', 'money', 1.1, { sum: true })],
        rows: data.slips,
      };
    },
  },
};

const REPORT_TYPES = Object.entries(BUILDERS).map(([key, b]) => ({ key, title: b.title }));

async function buildReport(type, params) {
  const b = BUILDERS[type];
  if (!b) throw bad(`Unknown report type "${type}"`);
  const report = await b.build(params);
  // Custom column selection: ?columns=name,gross,net_pay (order preserved)
  if (params.columns) {
    const keys = String(params.columns).split(',').map((s) => s.trim()).filter(Boolean);
    const byKey = new Map(report.columns.map((c) => [c.key, c]));
    const unknown = keys.filter((k) => !byKey.has(k));
    if (unknown.length) throw bad(`Unknown column(s): ${unknown.join(', ')}`);
    if (keys.length) report.columns = keys.map((k) => byKey.get(k));
  }
  report.title = b.title;
  report.type = type;
  report.totals = {};
  for (const c of report.columns) if (c.sum) report.totals[c.key] = report.rows.reduce((t, r) => t + (Number(r[c.key]) || 0), 0);
  return report;
}

const rawValue = (c, v) => (c.type === 'hours' ? Math.round(((Number(v) || 0) / 60) * 100) / 100 : v ?? '');
function textValue(c, v, currency) {
  if (v === null || v === undefined || v === '') return '';
  if (c.type === 'money') return fmtMoney(v);
  if (c.type === 'hours') return (Math.round(((Number(v) || 0) / 60) * 100) / 100).toFixed(2);
  return String(v);
}

function periodLabel(p) {
  if (p.month) return `Month: ${p.month}`;
  if (p.from && p.to && p.from === p.to) return `Attendance Date: ${p.from}`;
  return `Period: ${p.from} to ${p.to}`;
}

async function toXlsx(report, params) {
  const settings = await getSettings();
  const companyName = 'JEANS MANUFACTURING COMPANY LTD.';
  const wb = new ExcelJS.Workbook();
  wb.creator = companyName;
  wb.created = new Date();
  const ws = wb.addWorksheet(report.title.slice(0, 31), { views: [{ state: 'frozen', ySplit: 5 }] });
  const n = report.columns.length;

  // Title Banner
  ws.mergeCells(1, 1, 1, n);
  const titleCell = ws.getCell(1, 1);
  titleCell.value = companyName;
  titleCell.font = { bold: true, size: 15, color: { argb: 'FFFFFFFF' } };
  titleCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0F2942' } };
  titleCell.alignment = { vertical: 'middle', horizontal: 'center' };
  ws.getRow(1).height = 30;

  // Subtitle Banner
  ws.mergeCells(2, 1, 2, n);
  const subCell = ws.getCell(2, 1);
  subCell.value = String(report.title || 'Attendance Report').toUpperCase();
  subCell.font = { bold: true, size: 11, color: { argb: 'FF38BDF8' } };
  subCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E293B' } };
  subCell.alignment = { vertical: 'middle', horizontal: 'center' };
  ws.getRow(2).height = 22;

  // Meta Info Strip
  ws.mergeCells(3, 1, 3, n);
  const metaCell = ws.getCell(3, 1);
  const termLabel = params.deviceSn ? `Terminal: ${params.deviceSn === 'RKQ4262500336' ? 'ZK-uFace 800' : params.deviceSn === 'VDE2251500160' ? 'SenseFace 7A' : params.deviceSn}` : 'All Terminals';
  const dhakaTime = new Date().toLocaleString('en-GB', { timeZone: 'Asia/Dhaka', hour: '2-digit', minute: '2-digit', second: '2-digit', day: '2-digit', month: 'short', year: 'numeric' });
  const empLabel = (params.userId && report.rows.length) ? `Employee: ${report.rows[0].name} (${report.rows[0].employee_code || ''})` : null;
  metaCell.value = [report.subtitle || periodLabel(params), empLabel, termLabel, params.department ? `Department: ${params.department}` : null,
    `Total Records: ${report.rows.length}`, `Printed: ${dhakaTime} (Dhaka Time)`].filter(Boolean).join('   |   ');
  metaCell.font = { bold: false, size: 9.5, color: { argb: 'FF475569' } };
  metaCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1F5F9' } };
  metaCell.alignment = { vertical: 'middle', horizontal: 'center' };
  ws.getRow(3).height = 20;

  // Blank separator
  ws.getRow(4).height = 8;

  // Table Column Headers (Row 5)
  const header = ws.getRow(5);
  report.columns.forEach((c, i) => {
    const cell = header.getCell(i + 1);
    cell.value = c.header;
    cell.font = { bold: true, size: 10, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0F172A' } };
    cell.alignment = { vertical: 'middle', horizontal: ['int', 'money', 'hours'].includes(c.type) ? 'right' : 'center', wrapText: true };
    cell.border = {
      top: { style: 'thin', color: { argb: 'FF0F172A' } },
      bottom: { style: 'medium', color: { argb: 'FF0284C7' } },
      left: { style: 'thin', color: { argb: 'FF334155' } },
      right: { style: 'thin', color: { argb: 'FF334155' } },
    };
    ws.getColumn(i + 1).width = Math.max(12, Math.round(c.width * 15));
    if (c.type === 'money') ws.getColumn(i + 1).numFmt = '#,##0.00';
    if (c.type === 'hours') ws.getColumn(i + 1).numFmt = '0.00';
  });
  header.height = 26;

  // Data Rows
  report.rows.forEach((r, rIdx) => {
    const rowValues = report.columns.map((c) => {
      const v = r[c.key];
      if (c.key === 'check_out_local' && (!v || v === '—' || v === 'On Duty') && r.check_in_local && r.check_in_local !== '—') {
        return 'Missing Checkout';
      }
      return rawValue(c, v);
    });
    const row = ws.addRow(rowValues);
    row.height = 20;
    const isEven = rIdx % 2 === 0;
    const bg = isEven ? 'FFFFFFFF' : 'FFF8FAFC';

    report.columns.forEach((c, cIdx) => {
      const cell = row.getCell(cIdx + 1);
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: bg } };
      cell.border = {
        top: { style: 'thin', color: { argb: 'FFE2E8F0' } },
        bottom: { style: 'thin', color: { argb: 'FFE2E8F0' } },
        left: { style: 'thin', color: { argb: 'FFE2E8F0' } },
        right: { style: 'thin', color: { argb: 'FFE2E8F0' } },
      };
      cell.alignment = { vertical: 'middle', horizontal: ['int', 'money', 'hours'].includes(c.type) ? 'right' : 'left' };

      // High-visibility color formatting for time and status
      if (c.key === 'check_in_local' && cell.value && cell.value !== '—') {
        cell.font = { color: { argb: 'FF15803D' }, bold: true };
      } else if (c.key === 'check_out_local') {
        if (cell.value === 'Missing Checkout') {
          cell.font = { color: { argb: 'FFB91C1C' }, bold: true };
        } else if (cell.value && cell.value !== '—') {
          cell.font = { color: { argb: 'FFDC2626' }, bold: true };
        }
      } else if (c.key === 'worked_minutes' || c.type === 'hours') {
        cell.font = { bold: true };
      } else if (c.key === 'status') {
        const s = String(cell.value || '').toLowerCase();
        if (s.includes('present')) cell.font = { color: { argb: 'FF15803D' }, bold: true };
        else if (s.includes('late')) cell.font = { color: { argb: 'FFB45309' }, bold: true };
        else if (s.includes('absent')) cell.font = { color: { argb: 'FFDC2626' }, bold: true };
      }
    });
  });

  // Summary Total Row
  if (report.rows.length) {
    const totalRow = ws.addRow(report.columns.map((c, i) => (i === 0 ? 'Total' : c.sum ? rawValue(c, report.totals[c.key]) : '')));
    totalRow.height = 24;
    totalRow.font = { bold: true, size: 10 };
    totalRow.eachCell((cell) => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1F5F9' } };
      cell.border = {
        top: { style: 'thin', color: { argb: 'FF0F172A' } },
        bottom: { style: 'double', color: { argb: 'FF0F172A' } },
      };
    });
    ws.autoFilter = { from: { row: 5, column: 1 }, to: { row: 5 + report.rows.length, column: n } };
  }
  return wb.xlsx.writeBuffer();
}

function registerFonts(doc) {
  const regular = process.env.PDF_FONT;
  const bold = process.env.PDF_FONT_BOLD || regular;
  if (regular && fs.existsSync(regular)) {
    doc.registerFont('Body', regular);
    doc.registerFont('Body-Bold', bold && fs.existsSync(bold) ? bold : regular);
    return { regular: 'Body', bold: 'Body-Bold' };
  }
  return { regular: 'Helvetica', bold: 'Helvetica-Bold' };
}

/** Stream a paginated table PDF into `res`. */
async function toPdf(report, params, res) {
  const settings = await getSettings();
  const landscape = report.columns.length > 6;
  const doc = new PDFDocument({ size: 'A4', layout: landscape ? 'landscape' : 'portrait', margin: 32, bufferPages: true, info: { Title: report.title, Author: 'Jeans Manufacturing Company Ltd.' } });
  const f = registerFonts(doc);
  doc.pipe(res);

  const left = doc.page.margins.left;
  const usable = doc.page.width - left - doc.page.margins.right;
  const totalWeight = report.columns.reduce((t, c) => t + c.width, 0);
  const cols = report.columns.map((c) => ({ ...c, w: (c.width / totalWeight) * usable }));
  const fontSize = cols.length > 10 ? 7 : 8.5;
  const rowH = fontSize + 9;
  const INK = '#0F172A';
  const MUTED = '#475569';

  const cell = (text, c, x, y, bold = false) => {
    let color = INK;
    let isBold = bold;
    if (c.key === 'check_in_local' && text && text !== '—') {
      color = '#15803d';
      isBold = true;
    }
    if (c.key === 'check_out_local') {
      if (text === 'Missing Checkout') {
        color = '#b91c1c';
        isBold = true;
      } else if (text && text !== '—') {
        color = '#dc2626';
        isBold = true;
      }
    }
    if (c.key === 'worked_minutes' || c.type === 'hours') {
      isBold = true;
      color = '#0f172a';
    }
    if (c.key === 'status') {
      const s = String(text || '').toLowerCase();
      if (s.includes('present')) color = '#15803d';
      else if (s.includes('late')) color = '#b45309';
      else if (s.includes('absent')) color = '#dc2626';
      else if (s.includes('half')) color = '#d97706';
    }

    doc.font(isBold ? f.bold : f.regular).fontSize(fontSize).fillColor(color)
      .text(text, x + 4, y + 4.5, { width: c.w - 8, height: fontSize + 2, ellipsis: true, align: ['int', 'money', 'hours'].includes(c.type) ? 'right' : 'left', lineBreak: false });
  };

  const header = (y) => {
    doc.rect(left, y, usable, rowH + 4).fill('#0F2942');
    let x = left;
    for (const c of cols) {
      doc.font(f.bold).fontSize(fontSize).fillColor('#FFFFFF')
        .text(c.header, x + 4, y + 5.5, { width: c.w - 8, height: fontSize + 2, ellipsis: true, align: ['int', 'money', 'hours'].includes(c.type) ? 'right' : 'left', lineBreak: false });
      x += c.w;
    }
    return y + rowH + 4;
  };

  // Top Accent Bar
  doc.rect(left, 20, usable, 4).fill('#0284c7');

  // Executive Title
  doc.font(f.bold).fontSize(16).fillColor('#0F2942').text('JEANS MANUFACTURING COMPANY LTD.', left, 30);
  doc.font(f.bold).fontSize(11).fillColor('#1E3A8A').text(report.title.toUpperCase());

  // Meta info strip
  const termLabel = params.deviceSn ? `Terminal: ${params.deviceSn === 'RKQ4262500336' ? 'ZK-uFace 800' : params.deviceSn === 'VDE2251500160' ? 'SenseFace 7A' : params.deviceSn}` : 'All Terminals';
  const dhakaTime = new Date().toLocaleString('en-GB', { timeZone: 'Asia/Dhaka', hour: '2-digit', minute: '2-digit', day: '2-digit', month: 'short', year: 'numeric' });
  const empLabel = (params.userId && report.rows.length) ? `Employee: ${report.rows[0].name} (${report.rows[0].employee_code || ''})` : null;
  doc.fontSize(8).fillColor(MUTED).text([
    report.subtitle || periodLabel(params),
    empLabel,
    termLabel,
    params.department ? `Dept: ${params.department}` : null,
    `Total: ${report.rows.length} records`,
    `Printed: ${dhakaTime}`
  ].filter(Boolean).join('   ·   '));

  let y = doc.y + 10;
  y = header(y);

  const bottom = () => doc.page.height - doc.page.margins.bottom - 18;
  report.rows.forEach((r, i) => {
    if (y + rowH > bottom()) { doc.addPage(); y = header(doc.page.margins.top); }
    if (i % 2 === 0) doc.rect(left, y, usable, rowH).fill('#F8FAFC');
    
    // Light bottom border on rows
    doc.moveTo(left, y + rowH).lineTo(left + usable, y + rowH).lineWidth(0.5).strokeColor('#E2E8F0').stroke();

    let x = left;
    for (const c of cols) {
      let val = textValue(c, r[c.key]);
      if (c.key === 'check_out_local') {
        if ((!val || val === '—' || val === 'On Duty') && r.check_in_local && r.check_in_local !== '—') {
          val = 'Missing Checkout';
        }
      }
      cell(val, c, x, y);
      x += c.w;
    }
    y += rowH;
  });

  if (!report.rows.length) {
    doc.font(f.regular).fontSize(10).fillColor(MUTED).text('No records match these filters.', left, y + 12);
  } else {
    if (y + rowH > bottom()) { doc.addPage(); y = doc.page.margins.top; }
    doc.moveTo(left, y).lineTo(left + usable, y).lineWidth(1.2).strokeColor('#0F2942').stroke();
    let x = left;
    cols.forEach((c, i) => { cell(i === 0 ? 'Total' : c.sum ? textValue(c, report.totals[c.key]) : '', c, x, y, true); x += c.w; });
  }

  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    doc.font(f.regular).fontSize(7.5).fillColor(MUTED)
      .text(`Page ${i + 1} of ${range.count}   ·   Jeans Manufacturing Company Ltd. Biometric System   ·   ${dhakaTime}`,
        left, doc.page.height - doc.page.margins.bottom - 4, { width: usable, align: 'right', lineBreak: false });
  }
  doc.end();
}

/** Single payslip as a PDF. */
async function payslipPdf(p, res) {
  const settings = await getSettings();
  const cur = settings.currency;
  const doc = new PDFDocument({ size: 'A4', margin: 48, info: { Title: `Payslip ${p.month} — ${p.name}`, Author: settings.company_name } });
  const f = registerFonts(doc);
  doc.pipe(res);
  const INK = '#0F1B2A', MUTED = '#5B6B7C';
  const left = 48, width = doc.page.width - 96;

  doc.font(f.bold).fontSize(18).fillColor(INK).text(settings.company_name, left, 48);
  doc.font(f.regular).fontSize(11).fillColor(MUTED).text(`Payslip for ${p.month}`);
  if (p.run_status !== 'finalized') doc.fillColor('#B42318').fontSize(9).text('DRAFT — not final until payroll is finalised');
  doc.moveDown(1);

  const kv = (k, v, x, y) => {
    doc.font(f.regular).fontSize(8.5).fillColor(MUTED).text(k, x, y, { width: 200, lineBreak: false });
    doc.font(f.bold).fontSize(10.5).fillColor(INK).text(v || '—', x, y + 11, { width: 200, lineBreak: false });
  };
  const y0 = doc.y;
  kv('Employee', p.name, left, y0); kv('Employee code', p.employee_code, left + 260, y0);
  kv('Department', p.department, left, y0 + 34); kv('Designation', p.designation, left + 260, y0 + 34);
  doc.y = y0 + 78;

  const b = p.breakdown || {};
  const section = (title, items, totalLabel, total) => {
    doc.font(f.bold).fontSize(10).fillColor(INK).text(title, left, doc.y);
    doc.moveTo(left, doc.y + 2).lineTo(left + width, doc.y + 2).lineWidth(0.8).strokeColor(INK).stroke();
    doc.moveDown(0.5);
    for (const [label, amt, note] of items) {
      const y = doc.y;
      doc.font(f.regular).fontSize(9.5).fillColor(INK).text(label, left, y, { width: 260, lineBreak: false });
      if (note) doc.fillColor(MUTED).fontSize(8).text(note, left + 200, y + 1, { width: 190, lineBreak: false });
      doc.font(f.regular).fontSize(9.5).fillColor(INK).text(fmtMoney(amt), left + width - 110, y, { width: 110, align: 'right', lineBreak: false });
      doc.y = y + 16;
    }
    const y = doc.y;
    doc.font(f.bold).fontSize(10).text(totalLabel, left, y, { width: 260, lineBreak: false })
      .text(`${cur} ${fmtMoney(total)}`, left + width - 160, y, { width: 160, align: 'right', lineBreak: false });
    doc.y = y + 28;
  };

  section('Earnings', [
    ['Base pay', p.base_pay, b.workingDaysActual < b.workingDaysFull ? `prorated ${b.workingDaysActual}/${b.workingDaysFull} days` : null],
    ['Allowances', p.allowances],
    ['Overtime', p.overtime_pay, (b.overtimeMinutes || b.offDayOvertimeMinutes) ? `${fmtMin((b.overtimeMinutes || 0) + (b.offDayOvertimeMinutes || 0))} h` : null],
    ['Bonus', p.bonus, b.attendanceBonus ? 'incl. attendance bonus' : null],
  ], 'Gross earnings', p.gross);
  section('Deductions', [
    ['Absence / unpaid leave', p.absence_deduction, `${(b.absentDays || 0) + (b.unpaidLeaveDays || 0) + (b.halfDays || 0) * 0.5} day(s)`],
    ['Late arrivals', p.late_deduction, `${b.lateCount || 0} late, ${b.lateDeductionDays || 0} day(s) deducted`],
    ['Provident fund', p.pf_deduction],
    ['Income tax', p.tax_deduction],
    ['Other deductions', p.other_deduction],
  ], 'Total deductions', p.total_deductions);

  const netY = doc.y;
  doc.rect(left, netY, width, 34).fill(INK);
  doc.font(f.bold).fontSize(12).fillColor('#FFFFFF')
    .text('Net pay', left + 12, netY + 11, { lineBreak: false })
    .text(`${cur} ${fmtMoney(p.net_pay)}`, left + width - 222, netY + 11, { width: 210, align: 'right', lineBreak: false });
  doc.end();
}

module.exports = { REPORT_TYPES, buildReport, toXlsx, toPdf, payslipPdf };

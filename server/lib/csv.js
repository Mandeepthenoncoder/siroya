'use strict';
/* CSV writer with formula-injection protection: any cell starting with
   = + - @ (or a tab / carriage return) is prefixed with an apostrophe. */

function cell(value) {
  let s = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

function toCsv(columns, rows) {
  const lines = [columns.map(c => cell(c.label)).join(',')];
  for (const row of rows) lines.push(columns.map(c => cell(row[c.key])).join(','));
  // BOM so Excel opens UTF-8 (Arabic, Hindi, accents) correctly.
  return `﻿${lines.join('\r\n')}\r\n`;
}

module.exports = { toCsv, cell };

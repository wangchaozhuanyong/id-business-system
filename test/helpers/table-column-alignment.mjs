// Compare the painted text, including headers with a trailing help control.
export async function tableColumnAlignment(scope) {
  return scope.evaluate(root => {
    const findings = [];
    let measurements = 0;
    const textBox = node => {
      if (!node) return null;
      const range = document.createRange();
      range.selectNodeContents(node);
      const rects = [...range.getClientRects()].filter(rect => rect.width);
      return rects.length === 1 ? rects[0] : null;
    };
    const plainText = node => node?.childElementCount === 0 && node.textContent.trim() ? node : null;
    for (const table of root.querySelectorAll('table')) {
      const head = table.tHead;
      if (head?.rows.length !== 1 || !head.checkVisibility()) continue;
      const headers = [...head.rows[0].cells];
      if (headers.some(th => th.colSpan !== 1 || th.rowSpan !== 1)) continue;
      const columns = headers.map(th => {
        const label = th.querySelector(':scope > .title-with-help > span') || plainText(th);
        const box = textBox(label);
        if (!box || getComputedStyle(th).display !== 'table-cell') return null;
        const align = getComputedStyle(th).textAlign;
        const edge = ['end', 'right'].includes(align) ? 'right' : align === 'center' ? 'center' : 'left';
        return { name: label.textContent.trim(), edge, box };
      });
      for (const body of table.tBodies) for (const row of body.rows) {
        if (row.cells.length !== headers.length || !row.checkVisibility() ||
            [...row.cells].some(cell => cell.colSpan !== 1 || cell.rowSpan !== 1)) continue;
        for (const [index, column] of columns.entries()) {
          if (!column) continue;
          const cell = row.cells[index];
          const value = cell.querySelector(':scope > .mobile-record-value') || cell;
          // A badge or action group has its own inset. Measure ordinary values and
          // the primary amount in a stacked or clickable numeric cell.
          const label = plainText(value) || (cell.classList.contains('table-number') &&
            value.querySelector('.table-amount, .commerce-stat-amounts > :first-child, .text-button'));
          const box = textBox(label);
          if (!box || getComputedStyle(cell).display !== 'table-cell') continue;
          const anchor = rect => column.edge === 'center' ? (rect.left + rect.right) / 2 : rect[column.edge];
          const delta = Math.abs(anchor(column.box) - anchor(box));
          measurements++;
          if (delta > 1) findings.push({
            table: table.dataset.table || table.getAttribute('aria-label') || table.className,
            column: column.name, row: row.sectionRowIndex + 1, offset: Math.round(delta * 100) / 100
          });
        }
      }
    }
    return { measurements, findings };
  });
}

/**
 * 校验用户 SQL：仅允许单条语句，且必须以 SELECT / WITH / EXPLAIN 开头（防写库）。
 */
export function assertReadOnlySql(sql: string): void {
  const trimmed = sql.trim();
  if (!trimmed) {
    throw new Error('SQL must not be empty');
  }
  const single = trimmed.replace(/;+\s*$/g, ''); // 去掉末尾分号再查多语句
  if (single.includes(';')) {
    throw new Error('Multiple SQL statements are not allowed');
  }
  const lead = single.replace(/^\s*/, '');
  const head = lead.slice(0, 24).toUpperCase();
  const allowed =
    head.startsWith('SELECT') ||
    head.startsWith('WITH') ||
    head.startsWith('EXPLAIN');
  if (!allowed) {
    throw new Error('Only SELECT, WITH, or EXPLAIN queries are allowed');
  }
}

// 畫面共用的格式化工具
export const money = (n: number) => `${n < 0 ? '-' : ''}$${Math.abs(Math.round(n || 0)).toLocaleString()}`;
export const num = (n: number) => Math.round(n || 0).toLocaleString();

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];

function parse(dateStr: string) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

/** 11/17（二） */
export function dateLabel(dateStr: string, withWeekday = true): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return '-';
  const d = parse(dateStr);
  const md = `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
  return withWeekday ? `${md}（${WEEKDAYS[d.getUTCDay()]}）` : md;
}

/** 今天 / 明天 / 3 天後 / 2 天前 */
export function relativeDay(dateStr: string, todayStr: string): string {
  const diff = Math.round((parse(dateStr).getTime() - parse(todayStr).getTime()) / 86400000);
  if (diff === 0) return '今天';
  if (diff === 1) return '明天';
  if (diff === -1) return '昨天';
  return diff > 0 ? `${diff} 天後` : `${-diff} 天前`;
}

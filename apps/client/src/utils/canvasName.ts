/**
 * Automatically calculates the next canvas title with incremented number.
 * Examples:
 *  - "週末繪茶" -> "週末繪茶 2"
 *  - "摸魚草稿 1" -> "摸魚草稿 2"
 *  - "角色企劃 #3" -> "角色企劃 #4"
 *  - "Sketch 09" -> "Sketch 10"
 *  - "" -> "未命名畫布 1"
 */
export function getNextCanvasTitle(lastTitle?: string): string {
  if (!lastTitle || !lastTitle.trim()) {
    return '未命名畫布 1';
  }

  const trimmed = lastTitle.trim();
  const match = trimmed.match(/^(.*?)(?:[\s_#\-]*)(\d+)$/);

  if (match) {
    const prefix = match[1].trim();
    const numStr = match[2];
    const num = parseInt(numStr, 10);
    const nextNum = num + 1;

    // Preserve leading zeros if any (e.g. 01 -> 02)
    const padded =
      numStr.startsWith('0') && numStr.length > 1
        ? String(nextNum).padStart(numStr.length, '0')
        : String(nextNum);

    return prefix ? `${prefix} ${padded}` : `${padded}`;
  }

  // If no trailing number, append " 2"
  return `${trimmed} 2`;
}

/**
 * Next "圖層組 N": counts plain groups only (not animation folders, cel folders or reused cels)
 * and skips numbers already in use.
 */
export function nextGroupName(layers: Array<{ id: string; name: string; layerType: string; parentId?: string | null; meta?: { animation?: unknown; cel?: { ref?: string } } | null }>): string {
  const animationFolders = new Set(layers.filter((l) => l.layerType === 'group' && l.meta?.animation).map((l) => l.id));
  const plain = layers.filter((l) => l.layerType === 'group' && !l.meta?.animation && !(l.parentId && animationFolders.has(l.parentId)));
  const used = new Set(layers.map((l) => l.name));
  let n = plain.length + 1;
  while (used.has(`圖層組 ${n}`)) n++;
  return `圖層組 ${n}`;
}

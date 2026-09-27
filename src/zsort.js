// 纯逻辑：z-order 稳定排序。浏览器与 Node 测试共用。

/**
 * 稳定排序：先按 z 升序，z 相同按 seq（加入顺序）升序。
 * 不修改原数组，返回新数组。
 */
export function zsort(objects) {
  return objects
    .map((obj, index) => ({ obj, index }))
    .sort((a, b) => {
      const za = a.obj.z;
      const zb = b.obj.z;
      if (za !== zb) return za - zb;
      const sa = a.obj.seq ?? a.index;
      const sb = b.obj.seq ?? b.index;
      return sa - sb;
    })
    .map((e) => e.obj);
}

/** 校验数组是否满足 z-order 有序（用于测试与运行时自检）。 */
export function isZSorted(objects) {
  for (let i = 1; i < objects.length; i++) {
    const prev = objects[i - 1];
    const curr = objects[i];
    if (prev.z > curr.z) return false;
    if (prev.z === curr.z && (prev.seq ?? 0) > (curr.seq ?? 0)) return false;
  }
  return true;
}

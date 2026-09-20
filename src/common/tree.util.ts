/** 组树的最小契约：id / parentId / sort。雪花 id 均为 string，'0' 表示根 */
export interface TreeSource {
  id: string;
  parentId: string;
  sort: number;
}

/**
 * 平铺列表 → 树（权限树 / 团队树共用）。
 *
 * 做法：先按 sort 升序（同 sort 按 id 升序，雪花 id 单调递增 = 创建先后）
 * 预排一遍，再两遍扫描 —— 建 id → 节点 Map、把每个节点挂到父的 children 上。
 * 预排序后 children 与 roots 的追加顺序天然就是目标顺序，无需建完再递归排。
 *
 * toNode 负责把源对象映射成出参节点；children 数组由这里创建并传入，
 * 调用方直接组装进返回值 —— 因此不需要任何类型断言。
 *
 * **孤儿提升为根**：父节点不在传入集合时（典型场景：/permissions/me 只把
 * 「已授权」的菜单节点喂进来，用户拿到了子菜单却没拿到它的父菜单），
 * 与其把子菜单悄悄丢掉，不如浮到顶层 —— 前端少一项入口总好过数据凭空消失。
 */
export function buildTree<T extends TreeSource, N extends { children: N[] }>(
  nodes: T[],
  toNode: (node: T, children: N[]) => N,
): N[] {
  const sorted = [...nodes].sort(
    (a, b) => a.sort - b.sort || (a.id < b.id ? -1 : 1),
  );

  const byId = new Map<string, N>();
  for (const source of sorted) {
    byId.set(source.id, toNode(source, []));
  }

  const roots: N[] = [];
  for (const source of sorted) {
    const node = byId.get(source.id);
    // byId 在上一轮循环里刚放进去的，get 不会落空；判空只为让编译器安心
    if (!node) {
      continue;
    }
    const parent =
      source.parentId !== '0' ? byId.get(source.parentId) : undefined;
    if (parent) {
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  }

  return roots;
}

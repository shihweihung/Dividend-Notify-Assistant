// ---- 極簡的 Firestore 假物件（只實作這個流程用到的方法） ----
export type Store = Map<string, any>; // key: 文件完整路徑
export function makeDb(store: Store) {
  const docRef = (path: string): any => ({
    collection: (name: string) => colRef(`${path}/${name}`),
    get: async () => ({ exists: store.has(path), data: () => store.get(path) }),
    set: async (data: any) => { store.set(path, data); },
  });
  const colRef = (path: string, filters: ((d: any) => boolean)[] = []): any => ({
    doc: (id: string) => docRef(`${path}/${id}`),
    where: (field: string, op: string, value: any) => colRef(path, [...filters, (d: any) => {
      if (op === '>=') return d[field] >= value;
      if (op === '<=') return d[field] <= value;
      return d[field] === value;
    }]),
    get: async () => {
      const docs = [...store.entries()]
        .filter(([k]) => k.startsWith(path + '/') && !k.slice(path.length + 1).includes('/'))
        .filter(([, v]) => filters.every(f => f(v)))
        .map(([k, v]) => ({ id: k.slice(path.length + 1), data: () => v }));
      return { docs, empty: docs.length === 0 };
    },
  });
  return { collection: (name: string) => colRef(name) };
}

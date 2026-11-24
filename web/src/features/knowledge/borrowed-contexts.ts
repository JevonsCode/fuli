// 借鉴其他项目 on the knowledge page: how many projects one view may borrow, and
// how their graphs are read. Each borrowed project is one more address
// parameter (page and search) and one more graph read, so the number is
// bounded: hundreds of them would make a request the console refuses (its
// header limit) and hundreds of reads at once.

export const MAX_BORROWED_PROJECTS = 20
const CONCURRENT_READS = 4

/**
 * The borrowed project IDs after the person turned `ids` on or off. Turning off
 * always applies; turning on adds in the order given until the limit, and
 * `refused` says how many did not fit.
 */
export function toggleBorrowed(current: readonly string[], ids: readonly string[], on: boolean) {
  const selected = new Set(current)
  let refused = 0
  for (const id of ids) {
    if (!on) selected.delete(id)
    else if (selected.has(id)) continue
    else if (selected.size < MAX_BORROWED_PROJECTS) selected.add(id)
    else refused += 1
  }
  return { ids: [...selected], refused }
}

/** Each project's read, a few at a time, answers in the order asked. */
export async function readEach<T>(ids: readonly string[], read: (id: string) => Promise<T>): Promise<T[]> {
  const answers: T[] = []
  for (let start = 0; start < ids.length; start += CONCURRENT_READS) {
    answers.push(...await Promise.all(ids.slice(start, start + CONCURRENT_READS).map(read)))
  }
  return answers
}
